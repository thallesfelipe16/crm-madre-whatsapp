const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

pool.on('error', (err) => {
  console.error('[WA] Erro inesperado no pool do banco:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
