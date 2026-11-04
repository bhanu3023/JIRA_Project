// Read-only: finds every queue literally named "Dev" across every space's
// custom_queues config, and lists its current queueStatuses, so we know
// exactly which queue(s) "add a Deferred status to the Dev queue" means
// before touching anything.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  for (const row of rows) {
    const queues = row.queues || [];
    const devQueues = queues.filter((q) => String(q.name || '').trim().toLowerCase() === 'dev');
    for (const q of devQueues) {
      console.log(`\nSpace: ${row.space_key}  Queue id: ${q.id}  Name: "${q.name}"`);
      const statuses = q.queueStatuses || [];
      if (!statuses.length) {
        console.log('  (no queueStatuses configured yet -- falls back to the space-wide status list)');
      } else {
        for (const s of statuses) console.log(`  - ${s.name} (category: ${s.category}, id: ${s.id})`);
      }
    }
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
