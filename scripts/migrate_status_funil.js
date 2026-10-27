#!/usr/bin/env node
// Migration: adiciona status_funil e lead_crm_id a wa_conversations
// Rodar: node scripts/migrate_status_funil.js

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE wa_conversations
        ADD COLUMN IF NOT EXISTS status_funil VARCHAR(50) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS lead_crm_id  UUID         DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS lead_nome    VARCHAR(255) DEFAULT NULL
    `);

    console.log('✓ Colunas status_funil, lead_crm_id, lead_nome adicionadas a wa_conversations');

    await client.query('COMMIT');
    console.log('Migration concluída.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro na migration:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
