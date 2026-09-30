// User wants: once a Migration ticket is Resolved, the status dropdown
// should offer ONLY "Reopen" (not the full status list), and picking it
// should move the ticket to "In Progress". Checking Migration's current
// queueStatuses config first -- is there already a Reopen-style option,
// and what's the full list right now. Read-only.
//
// Usage: node check-migration-queue-statuses.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT space_key, queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = rows[0]?.queues || [];
  const migration = queues.find(q => (q.name || '').toLowerCase() === 'migration');
  console.log('Migration queue config:');
  console.log(JSON.stringify(migration, null, 2));
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
