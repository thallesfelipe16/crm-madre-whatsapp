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
    } else if (eventName === 'MESSAGES_UPDATE') {
      await _processarEdicao(instanceRef, evento);
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
      || msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption
      || msg.message?.contactMessage?.displayName
      || null;

    // Mensagem editada chega como MESSAGES_UPSERT com editedMessage no topo
    const editProto = msg.message?.editedMessage?.message?.protocolMessage;
    if (editProto && editProto.type === 14) {
      const originalMsgId = editProto.key?.id;
      const novoBody =
        editProto.editedMessage?.conversation ||
        editProto.editedMessage?.extendedTextMessage?.text ||
        null;
      if (originalMsgId && novoBody) {
        await db.query(
          `UPDATE wa_messages SET body = $1, edited_at = NOW()
           WHERE instance_ref = $2 AND provider_message_id = $3`,
          [novoBody, instanceRef, originalMsgId]
        );
        console.log(`[WA] Mensagem editada (upsert): ${originalMsgId} (${instanceRef})`);
      }
      continue;
    }

    const { messageType, mediaMime } = _detectarTipo(msg.message);

    // Tenta extrair base64 do próprio payload (quando webhook_base64=true na Evolution)
    // Fallback: chama getBase64FromMediaMessage
    let mediaKey = mediaMime ? { key: msg.key, message: msg.message } : null;
    if (mediaMime && direction === 'inbound') {
      const embeddedB64 = _extrairBase64Embutido(msg.message);
      if (embeddedB64) {
        mediaKey = { type: 'inline', base64: embeddedB64, mimetype: mediaMime };
        console.log(`[WA] base64 embutido extraído do webhook (${instanceRef})`);
      } else {
        try {
          const { baixarMidia } = require('../services/evolution');
          const dl = await baixarMidia(instanceRef, { key: msg.key, message: msg.message });
          const b64 = dl?.base64 || dl?.data;
          if (b64) {
            mediaKey = { type: 'inline', base64: b64, mimetype: dl?.mimetype || mediaMime };
            console.log(`[WA] base64 baixado via Evolution (${instanceRef})`);
          } else {
            console.warn(`[WA] Evolution retornou vazio para mídia (${instanceRef}):`, JSON.stringify(dl));
          }
        } catch (dlErr) {
          console.warn(`[WA] baixarMidia falhou (${instanceRef}):`, dlErr.message);
        }
      }
    }

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
      [uuidv4(), instanceRef, phoneE164, direction === 'inbound' ? (msg.pushName || null) : null]
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

async function _processarEdicao(instanceRef, evento) {
  const updates = Array.isArray(evento.data) ? evento.data : [evento.data];

  for (const upd of updates) {
    if (!upd?.key?.id) continue;

    const originalMsgId = upd.key.id;

    // A Evolution pode embalar a edição em dois formatos diferentes:
    // 1) upd.update.editedMessage.message.protocolMessage.editedMessage.conversation
    // 2) upd.update.message.protocolMessage.editedMessage.conversation
    const proto =
      upd.update?.editedMessage?.message?.protocolMessage ||
      upd.update?.message?.protocolMessage ||
      null;

    if (!proto || proto.type !== 14) continue; // type 14 = MESSAGE_EDIT

    const novoBody =
      proto.editedMessage?.conversation ||
      proto.editedMessage?.extendedTextMessage?.text ||
      null;

    if (!novoBody) continue;

    await db.query(
      `UPDATE wa_messages
       SET body = $1, edited_at = NOW()
       WHERE instance_ref = $2 AND provider_message_id = $3`,
      [novoBody, instanceRef, originalMsgId]
    );

    console.log(`[WA] Mensagem editada: ${originalMsgId} (${instanceRef})`);
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

function _extrairBase64Embutido(message) {
  if (!message) return null;
  // Evolution com webhook_base64=true embute o base64 em vários lugares possíveis
  const img = message.imageMessage;
  const aud = message.audioMessage;
  const vid = message.videoMessage;
  const doc = message.documentMessage;
  const src = img || aud || vid || doc;
  if (!src) return null;
  // Alguns builds da Evolution colocam em .base64, outros em .data
  return src.base64 || src.data || null;
}

function _detectarTipo(message) {
  if (!message) return { messageType: 'other', mediaMime: null };
  if (message.conversation || message.extendedTextMessage) return { messageType: 'text',     mediaMime: null };
  if (message.imageMessage)    return { messageType: 'image',    mediaMime: message.imageMessage.mimetype    || 'image/jpeg' };
  if (message.audioMessage)    return { messageType: 'audio',    mediaMime: message.audioMessage.mimetype    || 'audio/ogg' };
  if (message.videoMessage)    return { messageType: 'video',    mediaMime: message.videoMessage.mimetype    || 'video/mp4' };
  if (message.documentMessage) return { messageType: 'document', mediaMime: message.documentMessage.mimetype || 'application/octet-stream' };
  if (message.stickerMessage)  return { messageType: 'sticker',  mediaMime: 'image/webp' };
  if (message.contactMessage)  return { messageType: 'contact',  mediaMime: null };
  if (message.documentWithCaptionMessage) return { messageType: 'document', mediaMime: message.documentWithCaptionMessage?.message?.documentMessage?.mimetype || 'application/octet-stream' };
  if (message.viewOnceMessage || message.viewOnceMessageV2) return { messageType: 'viewonce', mediaMime: null };
  if (message.reactionMessage) return { messageType: 'reaction', mediaMime: null };
  if (message.pollCreationMessage) return { messageType: 'poll', mediaMime: null };
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
