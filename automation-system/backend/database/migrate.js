require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  // Run migration
  await pool.query("ALTER TABLE reminders ADD COLUMN IF NOT EXISTS last_visited_date DATE");
  await pool.query("ALTER TABLE reminders ADD COLUMN IF NOT EXISTS visited BOOLEAN NOT NULL DEFAULT FALSE");
  // Verify
  const r = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='reminders' ORDER BY ordinal_position");
  process.stdout.write('Columns: ' + r.rows.map(x=>x.column_name).join(', ') + '\n');
  await pool.end();
  process.exit(0);
}
run().catch(e => { process.stderr.write(e.message + '\n'); process.exit(1); });
