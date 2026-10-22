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

module.exports = router;
