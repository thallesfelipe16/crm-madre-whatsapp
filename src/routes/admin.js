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
      `SELECT id, direction, message_type, body, provider_timestamp, received_at, status
       FROM wa_messages
       WHERE conversation_id = $1
       ORDER BY received_at ASC, id ASC`,
      [req.params.id]
    );
    return res.json({ messages: rows });
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

// GET /admin/messages/:id/media — proxy de mídia (busca base64 da Evolution)
router.get('/messages/:id/media', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT instance_ref, media_mime_type, media_key FROM wa_messages WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length || !rows[0].media_key) return res.status(404).json({ erro: 'Mídia não encontrada.' });

    const { instance_ref, media_mime_type, media_key } = rows[0];
    const { baixarMidia } = require('../services/evolution');
    const result = await baixarMidia(instance_ref, media_key);

    const base64 = result?.base64 || result?.data;
    if (!base64) return res.status(404).json({ erro: 'Evolution não retornou mídia.' });

    const buf = Buffer.from(base64, 'base64');
    res.set('Content-Type', media_mime_type || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=3600');
    return res.send(buf);
  } catch (err) {
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
    const { enviarMidia } = require('../services/evolution');
    const result = await enviarMidia(instance_ref, phone_e164.replace('+', ''), { mediatype, mimetype, media, fileName, caption });

    const { v4: uuidv4 } = require('uuid');
    await db.query(
      `INSERT INTO wa_messages
         (id, conversation_id, instance_ref, provider_message_id, direction,
          message_type, body, media_mime_type, received_at, status)
       VALUES ($1, $2, $3, $4, 'outbound', $5, $6, $7, NOW(), 'sent')`,
      [uuidv4(), req.params.id, instance_ref, result?.key?.id || null,
       mediatype, caption || null, mimetype]
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
