const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

const ALLOWED_EVENTS = new Set([
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'MESSAGES_DELETE',
  'CONNECTION_UPDATE',
  'SEND_MESSAGE',
]);

async function receberEvento(req, res) {
  const instanceRef = req.instanceRef;
  const evento = req.body;
  // Normaliza: "messages.upsert" → "MESSAGES_UPSERT"
  const rawEvent = evento?.event || evento?.type || 'UNKNOWN';
  const eventName = rawEvent.toUpperCase().replace(/\./g, '_');

  // Responde 200 imediatamente — o processamento é assíncrono
  res.status(200).json({ recebido: true });

  // Evento desconhecido: loga sem payload sensível e descarta
  if (!ALLOWED_EVENTS.has(eventName)) {
    console.log(`[WA] Evento ignorado: ${eventName} (instância: ${instanceRef})`);
    return;
  }

  // Fingerprint de idempotência: evita processar o mesmo evento duas vezes
  const eventKey = _gerarEventKey(instanceRef, eventName, evento);

  try {
    // Persiste o evento bruto para processamento assíncrono
    await db.query(
      `INSERT INTO wa_webhook_events
         (id, instance_ref, event_name, event_key, payload, received_at, processing_state)
       VALUES ($1, $2, $3, $4, $5, NOW(), 'pending')
       ON CONFLICT (event_key) DO NOTHING`,
      [uuidv4(), instanceRef, eventName, eventKey, JSON.stringify(_sanitizarPayload(evento))]
    );

    // Processa inline para MVP (sem fila externa)
    await _processarEvento(instanceRef, eventName, evento, eventKey);

  } catch (err) {
    console.error(`[WA] Erro ao persistir evento ${eventName} (${instanceRef}):`, err.message);
  }
}

async function _processarEvento(instanceRef, eventName, evento, eventKey) {
  try {
    if (eventName === 'MESSAGES_UPSERT') {
      await _processarMensagem(instanceRef, evento);
    } else if (eventName === 'CONNECTION_UPDATE') {
      await _processarConexao(instanceRef, evento);
    }

    await db.query(
      `UPDATE wa_webhook_events SET processing_state = 'done', processed_at = NOW()
       WHERE event_key = $1`,
      [eventKey]
    );
  } catch (err) {
    console.error(`[WA] Erro ao processar evento ${eventName}:`, err.message);
    await db.query(
      `UPDATE wa_webhook_events
       SET processing_state = 'error', last_error = $1, attempt_count = attempt_count + 1
       WHERE event_key = $2`,
      [err.message.slice(0, 500), eventKey]
    );
  }
}

async function _processarMensagem(instanceRef, evento) {
  const msgs = Array.isArray(evento.data) ? evento.data : [evento.data];

  for (const msg of msgs) {
    if (!msg || !msg.key) continue;

    const remoteJid = msg.key.remoteJid;
    // Ignora mensagens de grupos
    if (remoteJid?.endsWith('@g.us')) continue;

    const phoneE164 = _normalizePhone(remoteJid);
    const direction = msg.key.fromMe ? 'outbound' : 'inbound';
    const providerMessageId = msg.key.id;
    const body = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || msg.message?.imageMessage?.caption
      || msg.message?.videoMessage?.caption
      || msg.message?.documentMessage?.caption
      || null;

    const { messageType, mediaMime } = _detectarTipo(msg.message);
    const mediaKey = mediaMime ? { id: providerMessageId, fromMe: msg.key.fromMe, remoteJid } : null;

    const providerTimestamp = msg.messageTimestamp
      ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
      : null;

    // Upsert do contato
    const { rows: contactRows } = await db.query(
      `INSERT INTO wa_contacts (id, instance_ref, phone_e164, display_name, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (instance_ref, phone_e164) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, wa_contacts.display_name),
         updated_at = NOW()
       RETURNING id`,
      [uuidv4(), instanceRef, phoneE164, msg.pushName || null]
    );
    const contactId = contactRows[0].id;

    // Upsert da conversa
    const { rows: convRows } = await db.query(
      `INSERT INTO wa_conversations (id, instance_ref, contact_id, state, last_message_at, updated_at)
       VALUES ($1, $2, $3, 'open', NOW(), NOW())
       ON CONFLICT (instance_ref, contact_id) DO UPDATE SET
         last_message_at = NOW(),
         updated_at = NOW(),
         unread_count = CASE
           WHEN EXCLUDED.state != 'resolved' THEN wa_conversations.unread_count + 1
           ELSE wa_conversations.unread_count
         END
       RETURNING id`,
      [uuidv4(), instanceRef, contactId]
    );
    const conversationId = convRows[0].id;

    // Insere mensagem (idempotente por provider_message_id + instance_ref + direction)
    await db.query(
      `INSERT INTO wa_messages
         (id, conversation_id, instance_ref, provider_message_id, direction,
          message_type, body, media_mime_type, media_key, provider_timestamp, received_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), 'received')
       ON CONFLICT (instance_ref, provider_message_id, direction) DO NOTHING`,
      [uuidv4(), conversationId, instanceRef, providerMessageId,
       direction, messageType, body, mediaMime || null,
       mediaKey ? JSON.stringify(mediaKey) : null, providerTimestamp]
    );
  }
}

async function _processarConexao(instanceRef, evento) {
  const state = evento.data?.state || 'unknown';
  await db.query(
    `UPDATE wa_accounts SET connection_state = $1, updated_at = NOW()
     WHERE instance_ref = $2`,
    [state, instanceRef]
  );
  console.log(`[WA] Conexão ${instanceRef}: ${state}`);
}

function _detectarTipo(message) {
  if (!message) return { messageType: 'other', mediaMime: null };
  if (message.conversation || message.extendedTextMessage) return { messageType: 'text', mediaMime: null };
  if (message.imageMessage)    return { messageType: 'image',    mediaMime: message.imageMessage.mimetype    || 'image/jpeg' };
  if (message.audioMessage)    return { messageType: 'audio',    mediaMime: message.audioMessage.mimetype    || 'audio/ogg' };
  if (message.videoMessage)    return { messageType: 'video',    mediaMime: message.videoMessage.mimetype    || 'video/mp4' };
  if (message.documentMessage) return { messageType: 'document', mediaMime: message.documentMessage.mimetype || 'application/octet-stream' };
  if (message.stickerMessage)  return { messageType: 'sticker',  mediaMime: 'image/webp' };
  return { messageType: 'other', mediaMime: null };
}

function _gerarEventKey(instanceRef, eventName, evento) {
  const msgId = evento?.data?.key?.id
    || evento?.data?.[0]?.key?.id
    || evento?.data?.id
    || null;
  const base = msgId
    ? `${instanceRef}:${eventName}:${msgId}`
    : `${instanceRef}:${eventName}:${Date.now()}:${Math.random()}`;
  return base.slice(0, 500);
}

// Remove campos que não precisam ser persistidos no payload bruto
function _sanitizarPayload(evento) {
  const { event, instance, data } = evento;
  return { event, instance, data_keys: data ? Object.keys(data) : [] };
}

function _normalizePhone(jid) {
  if (!jid) return null;
  const num = jid.split('@')[0].replace(/\D/g, '');
  return num ? `+${num}` : null;
}

module.exports = { receberEvento };
