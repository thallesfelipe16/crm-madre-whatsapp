require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const db = require('./config/db');

const webhookRoutes = require('./routes/webhook');
const adminRoutes = require('./routes/admin');

const app = express();

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '20mb' }));

app.use(cors({ origin: true, credentials: true }));

app.get('/health/live', (req, res) => res.json({ status: 'ok', modulo: 'crm-madre-whatsapp', versao: '0.1.0' }));

app.get('/health/ready', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'conectado' });
  } catch (err) {
    res.status(503).json({ status: 'erro', db: err.message });
  }
});

app.use('/webhooks', webhookRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));
app.use((err, req, res, next) => {
  console.error('[WA] Erro não tratado:', err);
  res.status(500).json({ erro: 'Erro interno no servidor.' });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[WA] crm-madre-whatsapp rodando na porta ${PORT}`);
});
