const router = require('express').Router();
const { listInstances } = require('../config/instances');
const { criarInstancia, obterQRCode, statusConexao } = require('../services/evolution');
const db = require('../config/db');

// GET /admin/instances — lista instâncias configuradas e status de conexão
router.get('/instances', async (req, res) => {
  try {
    const instances = listInstances();
    const statuses = await Promise.all(
      instances.map(async ({ ref, label }) => {
        const status = await statusConexao(ref).catch(() => ({ state: 'unknown' }));
        return { ref, label, state: status?.instance?.state || status?.state || 'unknown' };
      })
    );
    return res.json(statuses);
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// POST /admin/instances/:ref/create — cria instância na Evolution e salva no banco
router.post('/instances/:ref/create', async (req, res) => {
  const { ref } = req.params;
  const { listInstances: li } = require('../config/instances');
  const instance = li().find(i => i.ref === ref);
  if (!instance) return res.status(404).json({ erro: 'Instância não configurada.' });

  const { getInstance } = require('../config/instances');
  const cfg = getInstance(ref);
  const webhookUrl = `${process.env.APP_URL}/webhooks/${ref}`;

  try {
    const result = await criarInstancia(ref, webhookUrl, cfg.webhookSecret);

    await db.query(
      `INSERT INTO wa_accounts (id, instance_ref, label, connection_state)
       VALUES (gen_random_uuid(), $1, $2, 'close')
       ON CONFLICT (instance_ref) DO NOTHING`,
      [ref, instance.label]
    );

    return res.json({ criado: true, result });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// GET /admin/instances/:ref/qr — obtém QR code para conectar
router.get('/instances/:ref/qr', async (req, res) => {
  try {
    const qr = await obterQRCode(req.params.ref);
    return res.json(qr);
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// GET /admin/conversations — lista conversas (filtros: instance_ref, state, page)
router.get('/conversations', async (req, res) => {
  try {
    const { instance_ref, state, assigned_to, user_ref, page = 1 } = req.query;
    const limit = 30;
    const offset = (Number(page) - 1) * limit;

    const conditions = [];
    const params = [];
    if (instance_ref) { params.push(instance_ref); conditions.push(`c.instance_ref = $${params.length}`); }
    if (state)        { params.push(state);         conditions.push(`c.state = $${params.length}`); }
    if (assigned_to === 'me' && user_ref) {
      params.push(user_ref); conditions.push(`c.assigned_user_ref = $${params.length}`);
    } else if (assigned_to === 'unassigned') {
      conditions.push(`c.assigned_user_ref IS NULL`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);

    const { rows } = await db.query(
      `SELECT c.id, c.instance_ref, c.state, c.last_message_at, c.unread_count,
              c.assigned_user_ref, c.assigned_user_name,
              c.status_funil, c.lead_crm_id, c.lead_nome,
              ct.phone_e164, ct.display_name,
              m.body AS last_body, m.direction AS last_direction
       FROM wa_conversations c
       JOIN wa_contacts ct ON ct.id = c.contact_id
       LEFT JOIN LATERAL (
         SELECT body, direction FROM wa_messages
         WHERE conversation_id = c.id
         ORDER BY received_at DESC, id DESC LIMIT 1
       ) m ON true
       ${where}
       ORDER BY c.last_message_at DESC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({ conversations: rows });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// GET /admin/conversations/:id/messages — mensagens de uma conversa
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, direction, message_type, body, media_mime_type, media_key,
              provider_timestamp, received_at, status
       FROM wa_messages
       WHERE conversation_id = $1
       ORDER BY received_at ASC, id ASC`,
      [req.params.id]
    );
    // Para mensagens com base64 inline, inclui data URL direto (evita round-trip e resolve 0:00/0:00)
    const messages = rows.map(row => {
      const { media_key, ...rest } = row;
      if (media_key?.type === 'inline' && media_key.base64 && media_key.mimetype) {
        return { ...rest, media_data_url: `data:${media_key.mimetype};base64,${media_key.base64}` };
      }
      return rest;
    });
    return res.json({ messages });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// PATCH /admin/conversations/:id/assign — atribui conversa a um atendente
router.patch('/conversations/:id/assign', async (req, res) => {
  const { user_ref, user_name } = req.body;
  try {
    await db.query(
      `UPDATE wa_conversations
       SET assigned_user_ref = $1, assigned_user_name = $2, updated_at = NOW()
       WHERE id = $3`,
      [user_ref || null, user_name || null, req.params.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// PATCH /admin/conversations/:id/state — muda estado da conversa
router.patch('/conversations/:id/state', async (req, res) => {
  const { state } = req.body;
  const valid = ['open', 'pending', 'resolved', 'archived'];
  if (!valid.includes(state)) return res.status(400).json({ erro: 'Estado inválido.' });
  try {
    await db.query(
      `UPDATE wa_conversations SET state = $1, updated_at = NOW() WHERE id = $2`,
      [state, req.params.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// GET /admin/messages/:id/media — proxy de mídia
router.get('/messages/:id/media', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT instance_ref, media_mime_type, media_key FROM wa_messages WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length || !rows[0].media_key) return res.status(404).json({ erro: 'Mídia não encontrada.' });

    const { instance_ref, media_mime_type, media_key } = rows[0];

    let buf, mime;

    // Inline (outbound salvo com base64 direto)
    if (media_key.type === 'inline') {
      buf = Buffer.from(media_key.base64, 'base64');
      mime = media_key.mimetype || media_mime_type || 'application/octet-stream';
    } else {
      // Inbound: busca da Evolution
      const { baixarMidia } = require('../services/evolution');
      const result = await baixarMidia(instance_ref, media_key);
      const base64 = result?.base64 || result?.data;
      if (!base64) return res.status(404).json({ erro: 'Evolution não retornou mídia.' });
      buf = Buffer.from(base64, 'base64');
      mime = result?.mimetype || media_mime_type || 'application/octet-stream';
    }

    // Suporte a Range requests (necessário para áudio com duração correta no browser)
    const total = buf.length;
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const [startStr, endStr] = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : total - 1;
      const chunkSize = end - start + 1;
      res.status(206);
      res.set({
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mime,
        'Cache-Control': 'private, max-age=3600',
      });
      return res.send(buf.slice(start, end + 1));
    }

    res.set({
      'Content-Type': mime,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    });
    return res.send(buf);
  } catch (err) {
    console.error('[WA] media proxy error:', err.message);
    return res.status(500).json({ erro: err.message });
  }
});

// POST /admin/conversations/:id/send-media — envia mídia
router.post('/conversations/:id/send-media', async (req, res) => {
  const { mediatype, mimetype, media, fileName, caption } = req.body;
  if (!media || !mediatype) return res.status(400).json({ erro: 'media e mediatype obrigatórios.' });

  try {
    const { rows } = await db.query(
      `SELECT c.instance_ref, ct.phone_e164
       FROM wa_conversations c JOIN wa_contacts ct ON ct.id = c.contact_id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Conversa não encontrada.' });

    const { instance_ref, phone_e164 } = rows[0];
    const { enviarMidia, enviarAudio } = require('../services/evolution');
    const pureBase64 = media.includes(',') ? media.split(',')[1] : media;
    // Áudio: usa sendWhatsAppAudio (PTT) para chegar como mensagem de voz no WhatsApp
    const result = mediatype === 'audio'
      ? await enviarAudio(instance_ref, phone_e164.replace('+', ''), pureBase64)
      : await enviarMidia(instance_ref, phone_e164.replace('+', ''), { mediatype, mimetype, media, fileName, caption });

    const { v4: uuidv4 } = require('uuid');
    // Para outbound, salva base64 inline — evita round-trip ao Evolution
    const inlineKey = JSON.stringify({ type: 'inline', base64: pureBase64, mimetype });
    await db.query(
      `INSERT INTO wa_messages
         (id, conversation_id, instance_ref, provider_message_id, direction,
          message_type, body, media_mime_type, media_key, received_at, status)
       VALUES ($1, $2, $3, $4, 'outbound', $5, $6, $7, $8, NOW(), 'sent')`,
      [uuidv4(), req.params.id, instance_ref, result?.key?.id || null,
       mediatype, caption || null, mimetype, inlineKey]
    );

    await db.query(
      `UPDATE wa_conversations SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// POST /admin/conversations/iniciar — encontra ou cria conversa para um número
// Usado pelo CRM para abrir lead diretamente no Inbox
router.post('/conversations/iniciar', async (req, res) => {
  const { phone, instance_ref } = req.body;
  if (!phone) return res.status(400).json({ erro: 'phone obrigatório.' });

  // Normaliza para E.164
  const digits = phone.replace(/\D/g, '');
  const phoneE164 = digits.startsWith('+') ? digits : `+${digits}`;

  try {
    // Instância padrão: primeira disponível ou a passada
    const { listInstances } = require('../config/instances');
    const ref = instance_ref || listInstances()[0]?.ref;
    if (!ref) return res.status(503).json({ erro: 'Nenhuma instância configurada.' });

    // Verifica se já existe conversa ativa
    const { rows } = await db.query(
      `SELECT c.id FROM wa_conversations c
       JOIN wa_contacts ct ON ct.id = c.contact_id
       WHERE ct.phone_e164 = $1 AND c.instance_ref = $2
       ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1`,
      [phoneE164, ref]
    );

    if (rows.length) {
      return res.json({ conversation_id: rows[0].id, criada: false });
    }

    // Não existe — cria contato + conversa (sem enviar mensagem ainda)
    const { v4: uuidv4 } = require('uuid');
    const { rows: ctRows } = await db.query(
      `INSERT INTO wa_contacts (id, instance_ref, phone_e164, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (instance_ref, phone_e164) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [uuidv4(), ref, phoneE164]
    );
    const contactId = ctRows[0].id;

    const { rows: convRows } = await db.query(
      `INSERT INTO wa_conversations (id, instance_ref, contact_id, state, updated_at)
       VALUES ($1, $2, $3, 'open', NOW())
       ON CONFLICT (instance_ref, contact_id) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [uuidv4(), ref, contactId]
    );

    return res.json({ conversation_id: convRows[0].id, criada: true });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// POST /admin/instances/:ref/webhook-reset — re-configura webhook com webhook_base64=true
router.post('/instances/:ref/webhook-reset', async (req, res) => {
  const { ref } = req.params;
  const { getInstance } = require('../config/instances');
  const cfg = getInstance(ref);
  if (!cfg) return res.status(404).json({ erro: 'Instância não configurada.' });
  const webhookUrl = `${process.env.APP_URL}/webhooks/${ref}`;
  try {
    const { atualizarWebhook } = require('../services/evolution');
    const result = await atualizarWebhook(ref, webhookUrl, cfg.webhookSecret);
    return res.json({ ok: true, result });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// PATCH /admin/conversations/:id/status-funil — atualiza etapa do funil
router.patch('/conversations/:id/status-funil', async (req, res) => {
  const { status_funil } = req.body;
  const VALID = [
    'novo_lead','contato_realizado','visita_agendada','visita_realizada',
    'teste_agendado','em_negociacao','fila_espera','matricula_concluida',
    'reprovado','perdido',
  ];
  if (status_funil !== null && !VALID.includes(status_funil)) {
    return res.status(400).json({ erro: 'status_funil inválido.' });
  }
  try {
    await db.query(
      `UPDATE wa_conversations SET status_funil = $1, updated_at = NOW() WHERE id = $2`,
      [status_funil, req.params.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// POST /admin/conversations/:id/criar-lead — cria lead no CRM e vincula à conversa
router.post('/conversations/:id/criar-lead', async (req, res) => {
  const { nome_responsavel, telefone, serie_interesse, unidade_id, status_funil } = req.body;
  if (!nome_responsavel) return res.status(400).json({ erro: 'nome_responsavel obrigatório.' });
  if (!serie_interesse)  return res.status(400).json({ erro: 'serie_interesse obrigatório.' });

  try {
    const { criarLead } = require('../services/crm');

    // Obtém o telefone da conversa se não passado
    let phone = telefone;
    if (!phone) {
      const { rows } = await db.query(
        `SELECT ct.phone_e164 FROM wa_conversations c JOIN wa_contacts ct ON ct.id = c.contact_id WHERE c.id = $1`,
        [req.params.id]
      );
      phone = rows[0]?.phone_e164 || null;
    }

    const lead = await criarLead({
      nome_responsavel,
      telefone: phone,
      serie_interesse,
      unidade_id: unidade_id || null,
      status_atual: status_funil || 'contato_realizado',
      origem_lead: 'whatsapp_inbox',
    });

    const leadId   = lead?.id   || lead?.lead?.id;
    const leadNome = lead?.nome_responsavel || lead?.lead?.nome_responsavel || nome_responsavel;

    await db.query(
      `UPDATE wa_conversations
       SET lead_crm_id = $1, lead_nome = $2, status_funil = $3, updated_at = NOW()
       WHERE id = $4`,
      [leadId, leadNome, status_funil || 'contato_realizado', req.params.id]
    );

    return res.json({ ok: true, lead_id: leadId, lead_nome: leadNome });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// POST /admin/conversations/:id/send — envia mensagem
router.post('/conversations/:id/send', async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ erro: 'Texto obrigatório.' });

  try {
    const { rows } = await db.query(
      `SELECT c.instance_ref, ct.phone_e164
       FROM wa_conversations c JOIN wa_contacts ct ON ct.id = c.contact_id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Conversa não encontrada.' });

    const { instance_ref, phone_e164 } = rows[0];
    const { enviarTexto } = require('../services/evolution');
    const result = await enviarTexto(instance_ref, phone_e164.replace('+', ''), text.trim());

    const { v4: uuidv4 } = require('uuid');
    await db.query(
      `INSERT INTO wa_messages
         (id, conversation_id, instance_ref, provider_message_id, direction,
          message_type, body, received_at, status)
       VALUES ($1, $2, $3, $4, 'outbound', 'text', $5, NOW(), 'sent')`,
      [uuidv4(), req.params.id, instance_ref, result?.key?.id || null, text.trim()]
    );

    await db.query(
      `UPDATE wa_conversations SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
