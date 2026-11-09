const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function run() {
  const { rowCount } = await pool.query(
    `UPDATE wa_contacts SET display_name = NULL, updated_at = NOW()
     WHERE display_name ILIKE 'Col_gio Madre%'`
  )
  console.log(`Corrigidos: ${rowCount} contatos`)
  await pool.end()
}

run().catch(e => { console.error(e); process.exit(1) })
