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

// POST /admin/contacts/profile-pics — busca fotos de perfil em lote na Evolution API
// Body: [{ instance_ref, phone }]  → retorna { "phone": "url | null" }
router.post('/contacts/profile-pics', async (req, res) => {
  const { fetchProfilePic } = require('../services/evolution');
  const contacts = Array.isArray(req.body) ? req.body : [];
  if (!contacts.length) return res.json({});
  // Limita a 50 por chamada para não travar
  const batch = contacts.slice(0, 50);
  const results = await Promise.all(
    batch.map(async ({ instance_ref, phone }) => {
      const url = await fetchProfilePic(instance_ref, phone).catch(() => null);
      return [phone, url];
    })
  );
  return res.json(Object.fromEntries(results));
});

// GET /admin/conversations — lista conversas (filtros: instance_ref, state, page)
router.get('/conversations', async (req, res) => {
  try {
    const { instance_ref, instance_refs, state, assigned_to, user_ref, page = 1 } = req.query;
    const limit = 30;
    const offset = (Number(page) - 1) * limit;

    const conditions = [];
    const params = [];
    if (instance_refs) {
      // Suporte a múltiplas instâncias (comma-separated): usado pelo Inbox para filtrar por campus
      const refs = instance_refs.split(',').map(r => r.trim()).filter(Boolean);
      if (refs.length === 1) {
        params.push(refs[0]); conditions.push(`c.instance_ref = $${params.length}`);
      } else if (refs.length > 1) {
        params.push(refs); conditions.push(`c.instance_ref = ANY($${params.length})`);
      }
    } else if (instance_ref) {
      params.push(instance_ref); conditions.push(`c.instance_ref = $${params.length}`);
    }
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
              m.body AS last_body, m.direction AS last_direction,
              COALESCE(
                (SELECT json_agg(json_build_object('user_id', mk.user_id, 'user_name', mk.user_name, 'color', mk.color))
                 FROM wa_markers mk WHERE mk.conversation_id = c.id),
                '[]'::json
              ) AS markers
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

// PATCH /admin/conversations/:id/read — zera contador de não lidas
router.patch('/conversations/:id/read', async (req, res) => {
  try {
    await db.query(
      `UPDATE wa_conversations SET unread_count = 0, updated_at = NOW() WHERE id = $1`,
      [req.params.id]
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
  const { phone, instance_ref, lead, assign_to, status_funil } = req.body;
  // lead: { nome_responsavel, nome_aluno, serie, campus, processo }
  // assign_to: { user_ref, user_name } — atribui conversa automaticamente
  // status_funil: sincroniza etapa do CRM no Inbox
  if (!phone) return res.status(400).json({ erro: 'phone obrigatório.' });

  // Normaliza para E.164
  const digits = phone.replace(/\D/g, '');
  const phoneE164 = digits.startsWith('+') ? digits : `+${digits}`;

  try {
    // Instância: usa a do campus do lead ou a primeira configurada
    const { listInstances } = require('../config/instances');
    const ref = instance_ref || listInstances()[0]?.ref;
    if (!ref) return res.status(503).json({ erro: 'Nenhuma instância configurada.' });

    // Bloqueia se a instância do campus não está conectada
    const { rows: accRows } = await db.query(
      `SELECT connection_state FROM wa_accounts WHERE instance_ref = $1`,
      [ref]
    );
    const connState = accRows[0]?.connection_state;
    if (!accRows.length || connState !== 'open') {
      return res.status(503).json({
        erro: `O WhatsApp deste campus (${ref}) está desconectado. Peça ao administrador para reconectar o QR Code.`,
        desconectado: true,
      });
    }

    // Verifica se já existe conversa ativa
    const { rows } = await db.query(
      `SELECT c.id FROM wa_conversations c
       JOIN wa_contacts ct ON ct.id = c.contact_id
       WHERE ct.phone_e164 = $1 AND c.instance_ref = $2
       ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1`,
      [phoneE164, ref]
    );

    // Monta texto de boas-vindas independente de ser nova ou existente
    const nomeResp  = lead?.nome_responsavel || ''
    const nomeAluno = lead?.nome_aluno || ''
    const serie     = lead?.serie || ''
    const campus    = lead?.campus || ''
    const primeiroNome = nomeResp.split(' ')[0] || 'responsável'
    const draftText = `Olá, ${primeiroNome}! 😊 Aqui é o Colégio Madre de Deus. Vi que você demonstrou interesse em uma vaga${nomeAluno ? ` para ${nomeAluno}` : ''}${serie ? ` (${serie})` : ''}${campus ? ` no ${campus}` : ''}. Posso te ajudar com mais informações? 🎓`

    if (rows.length) {
      const convId = rows[0].id
      // Atualiza nome do contato, atribuição e etapa do funil na conversa existente
      if (nomeResp) {
        await db.query(
          `UPDATE wa_contacts SET display_name = $1, updated_at = NOW()
           WHERE id = (SELECT contact_id FROM wa_conversations WHERE id = $2)`,
          [nomeResp, convId]
        )
      }
      const updFields = []
      const updParams = []
      if (assign_to?.user_ref) {
        updParams.push(String(assign_to.user_ref)); updFields.push(`assigned_user_ref = $${updParams.length}`)
        updParams.push(assign_to.user_name || '');  updFields.push(`assigned_user_name = $${updParams.length}`)
      }
      if (status_funil) {
        updParams.push(status_funil); updFields.push(`status_funil = $${updParams.length}`)
      }
      if (updFields.length) {
        updParams.push(convId)
        await db.query(`UPDATE wa_conversations SET ${updFields.join(', ')}, updated_at = NOW() WHERE id = $${updParams.length}`, updParams)
      }
      // Cria nota interna também para conversa existente (contexto do lead para a secretaria)
      if (lead && (nomeResp || nomeAluno)) {
        const { v4: uuidv4 } = require('uuid')
        const linhas = ['📋 Dados do Lead']
        if (nomeResp)       linhas.push(`👤 Responsável: ${nomeResp}`)
        if (nomeAluno)      linhas.push(`🎒 Estudante: ${nomeAluno}`)
        if (serie)          linhas.push(`📚 Série: ${serie}`)
        if (campus)         linhas.push(`🏫 Campus: ${campus}`)
        if (lead.processo)  linhas.push(`📅 Processo: ${lead.processo}`)
        await db.query(
          `INSERT INTO wa_messages
             (id, conversation_id, instance_ref, provider_message_id, direction,
              message_type, body, received_at, status)
           VALUES ($1, $2, $3, NULL, 'internal', 'note', $4, NOW(), 'delivered')`,
          [uuidv4(), convId, ref, linhas.join('\n')]
        )
      }
      return res.json({ conversation_id: convId, criada: false, draft: draftText });
    }

    // Não existe — cria contato + conversa (sem enviar mensagem ainda)
    const { v4: uuidv4 } = require('uuid');
    const { rows: ctRows } = await db.query(
      `INSERT INTO wa_contacts (id, instance_ref, phone_e164, display_name, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (instance_ref, phone_e164) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = NOW()
       RETURNING id`,
      [uuidv4(), ref, phoneE164, nomeResp || null]
    );
    const contactId = ctRows[0].id;

    const assignRef  = assign_to?.user_ref  ? String(assign_to.user_ref)  : null
    const assignName = assign_to?.user_name ? assign_to.user_name         : null
    const { rows: convRows } = await db.query(
      `INSERT INTO wa_conversations (id, instance_ref, contact_id, state, assigned_user_ref, assigned_user_name, status_funil, updated_at)
       VALUES ($1, $2, $3, 'open', $4, $5, $6, NOW())
       ON CONFLICT (instance_ref, contact_id) DO UPDATE
         SET updated_at = NOW(),
             assigned_user_ref  = COALESCE(EXCLUDED.assigned_user_ref,  wa_conversations.assigned_user_ref),
             assigned_user_name = COALESCE(EXCLUDED.assigned_user_name, wa_conversations.assigned_user_name),
             status_funil       = COALESCE(EXCLUDED.status_funil,       wa_conversations.status_funil)
       RETURNING id`,
      [uuidv4(), ref, contactId, assignRef, assignName, status_funil || null]
    );
    const convId = convRows[0].id

    // Nota interna com dados do lead (não enviada ao cliente)
    if (lead && (nomeResp || nomeAluno)) {
      const linhas = ['📋 Dados do Lead']
      if (nomeResp)       linhas.push(`👤 Responsável: ${nomeResp}`)
      if (nomeAluno)      linhas.push(`🎒 Estudante: ${nomeAluno}`)
      if (serie)          linhas.push(`📚 Série: ${serie}`)
      if (campus)         linhas.push(`🏫 Campus: ${campus}`)
      if (lead.processo)  linhas.push(`📅 Processo: ${lead.processo}`)
      await db.query(
        `INSERT INTO wa_messages
           (id, conversation_id, instance_ref, provider_message_id, direction,
            message_type, body, received_at, status)
         VALUES ($1, $2, $3, NULL, 'internal', 'note', $4, NOW(), 'delivered')`,
        [uuidv4(), convId, ref, linhas.join('\n')]
      )
    }

    return res.json({ conversation_id: convId, criada: true, draft: draftText });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// ─── MARCADORES ───────────────────────────────────────────────────────────────

// Garante que as tabelas de marcadores e notificações existem
async function ensureMarkerTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS wa_markers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES wa_conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_by_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(conversation_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS wa_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      conversation_id UUID REFERENCES wa_conversations(id) ON DELETE CASCADE,
      conv_contact_name TEXT,
      created_by_name TEXT NOT NULL,
      read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wa_markers_conv ON wa_markers(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_wa_notif_user ON wa_notifications(user_id, read);
  `);
}
ensureMarkerTables().catch(e => console.error('[WA] ensureMarkerTables:', e.message));

// POST /admin/conversations/:id/markers — adiciona marcador (marca outro atendente)
router.post('/conversations/:id/markers', async (req, res) => {
  const { user_id, user_name, color, created_by_id, created_by_name } = req.body;
  if (!user_id || !color) return res.status(400).json({ erro: 'user_id e color obrigatórios.' });
  try {
    await db.query(
      `INSERT INTO wa_markers (conversation_id, user_id, user_name, color, created_by_id, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET color = EXCLUDED.color, created_by_id = EXCLUDED.created_by_id, created_by_name = EXCLUDED.created_by_name, created_at = NOW()`,
      [req.params.id, String(user_id), user_name, color, String(created_by_id), created_by_name]
    );
    // Cria notificação para o usuário marcado (não notifica a si mesmo)
    if (String(user_id) !== String(created_by_id)) {
      const { rows: ctRows } = await db.query(
        `SELECT ct.display_name, ct.phone_e164 FROM wa_conversations c JOIN wa_contacts ct ON ct.id = c.contact_id WHERE c.id = $1`,
        [req.params.id]
      );
      const contactName = ctRows[0]?.display_name || ctRows[0]?.phone_e164 || 'contato';
      await db.query(
        `INSERT INTO wa_notifications (user_id, conversation_id, conv_contact_name, created_by_name)
         VALUES ($1, $2, $3, $4)`,
        [String(user_id), req.params.id, contactName, created_by_name]
      );
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// DELETE /admin/conversations/:id/markers/:userId — remove marcador
router.delete('/conversations/:id/markers/:userId', async (req, res) => {
  try {
    await db.query(
      `DELETE FROM wa_markers WHERE conversation_id = $1 AND user_id = $2`,
      [req.params.id, req.params.userId]
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// GET /admin/notifications?user_id= — notificações do usuário
router.get('/notifications', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ erro: 'user_id obrigatório.' });
  try {
    const { rows } = await db.query(
      `SELECT id, conversation_id, conv_contact_name, created_by_name, read, created_at
       FROM wa_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [String(user_id)]
    );
    return res.json({ notifications: rows });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// PATCH /admin/notifications/read — marca notificações como lidas
router.patch('/notifications/read', async (req, res) => {
  const { user_id, ids } = req.body; // ids: array de UUIDs, ou omitir para marcar todas
  if (!user_id) return res.status(400).json({ erro: 'user_id obrigatório.' });
  try {
    if (ids?.length) {
      await db.query(`UPDATE wa_notifications SET read = TRUE WHERE user_id = $1 AND id = ANY($2::uuid[])`, [String(user_id), ids]);
    } else {
      await db.query(`UPDATE wa_notifications SET read = TRUE WHERE user_id = $1`, [String(user_id)]);
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

// GET /admin/users — lista usuários do CRM com cor_marcador (proxy para CRM API)
router.get('/users', async (req, res) => {
  try {
    const { getToken } = require('../services/crm');
    const token = await getToken();
    const crmUrl = process.env.CRM_API_URL || 'http://crm-madre_crm-api:3000';
    const response = await fetch(`${crmUrl}/api/usuarios`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!response.ok) return res.status(response.status).json({ users: [] });
    const users = await response.json();
    return res.json({ users: (Array.isArray(users) ? users : []).map(u => ({
      id: String(u.id),
      nome: u.nome,
      perfil: u.perfil,
      cor_marcador: u.cor_marcador || null,
      unidade_id: u.unidade_id || null,
      unidade_ids: Array.isArray(u.unidades)
        ? u.unidades.map(un => un.id)
        : (u.unidade_id ? [u.unidade_id] : []),
    })) });
  } catch (err) {
    return res.status(500).json({ erro: err.message, users: [] });
  }
});

// GET /admin/stats/response-time — tempo médio de resposta por campus e por atendente
// Query params: instance_refs (comma-separated, opcional), days (padrão 7)
router.get('/stats/response-time', async (req, res) => {
  try {
    const { instance_refs, days = 7 } = req.query;
    const daysNum = Math.min(Math.max(Number(days) || 7, 1), 90);

    // Condição de filtro de instância
    let instanceCond = '';
    let instanceParams = [];
    if (instance_refs) {
      const refs = instance_refs.split(',').map(r => r.trim()).filter(Boolean);
      if (refs.length === 1) {
        instanceParams.push(refs[0]);
        instanceCond = `AND c.instance_ref = $2`;  // $1 = daysNum, $2 = ref
      } else if (refs.length > 1) {
        instanceParams.push(refs);
        instanceCond = `AND c.instance_ref = ANY($2::text[])`;
      }
    }

    // CTE: para cada mensagem inbound, encontra o próximo outbound na mesma conversa
    // e calcula o tempo de resposta em minutos. Ignora respostas > 24h (fim de semana etc.)
    const statsQuery = `
      WITH pairs AS (
        SELECT
          c.instance_ref,
          c.assigned_user_name,
          i.id AS inbound_id,
          i.received_at AS inbound_at,
          MIN(o.received_at) AS first_reply_at
        FROM wa_messages i
        JOIN wa_conversations c ON c.id = i.conversation_id
        JOIN wa_messages o
          ON o.conversation_id = i.conversation_id
         AND o.direction = 'outbound'
         AND o.received_at > i.received_at
        WHERE i.direction = 'inbound'
          AND i.received_at > NOW() - (INTERVAL '1 day' * $1)
          ${instanceCond}
        GROUP BY c.instance_ref, c.assigned_user_name, i.id, i.received_at
      ),
      with_time AS (
        SELECT
          instance_ref,
          assigned_user_name,
          EXTRACT(EPOCH FROM (first_reply_at - inbound_at)) / 60.0 AS resp_min
        FROM pairs
        WHERE first_reply_at - inbound_at < INTERVAL '24 hours'
          AND first_reply_at - inbound_at > INTERVAL '0 seconds'
      )
      SELECT
        'campus' AS tipo,
        instance_ref AS chave,
        NULL::text AS user_name,
        ROUND(AVG(resp_min)::numeric, 1) AS avg_min,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY resp_min)::numeric, 1) AS median_min,
        COUNT(*)::int AS total_respostas
      FROM with_time
      GROUP BY instance_ref

      UNION ALL

      SELECT
        'atendente' AS tipo,
        NULL AS chave,
        COALESCE(assigned_user_name, '(sem atendente)') AS user_name,
        ROUND(AVG(resp_min)::numeric, 1) AS avg_min,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY resp_min)::numeric, 1) AS median_min,
        COUNT(*)::int AS total_respostas
      FROM with_time
      WHERE assigned_user_name IS NOT NULL
      GROUP BY assigned_user_name
      ORDER BY tipo, avg_min
    `;

    const { rows } = await db.query(statsQuery, [daysNum, ...instanceParams]);

    const by_campus = rows.filter(r => r.tipo === 'campus').map(r => ({
      instance_ref: r.chave,
      avg_min: Number(r.avg_min),
      median_min: Number(r.median_min),
      total: r.total_respostas,
    }));
    const by_atendente = rows.filter(r => r.tipo === 'atendente').map(r => ({
      user_name: r.user_name,
      avg_min: Number(r.avg_min),
      median_min: Number(r.median_min),
      total: r.total_respostas,
    }));

    return res.json({ days: daysNum, by_campus, by_atendente });
  } catch (err) {
    console.error('[stats] response-time error:', err.message);
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

// DELETE /admin/conversations/:id — exclui conversa e mensagens (super_admin only)
router.delete('/conversations/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM wa_messages     WHERE conversation_id = $1', [req.params.id]);
    await db.query('DELETE FROM wa_conversations WHERE id = $1',             [req.params.id]);
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
