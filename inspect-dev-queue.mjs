/**
 * inspect-dev-queue.mjs
 * READ-ONLY diagnostic: dumps the Dev queue's queueStatuses and
 * queueTransitions from custom_queues, to debug why the "Move to status"
 * dropdown on a Dev ticket is only showing "Waiting for Pre-Sales" instead
 * of the full list (In Progress, Waiting for Dev/QA/Infra/Pre-Sales,
 * Resolved).
 *
 * Run: node inspect-dev-queue.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

async function main() {
  const { rows } = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  for (const row of rows) {
    const queues = row.queues || [];
    for (const q of queues) {
      if ((q.name || '').toLowerCase() === 'dev') {
        console.log(`\n=== space: ${row.space_key} | queue: ${q.name} (id: ${q.id}) ===`);
        console.log('queueStatuses:');
        console.log(JSON.stringify(q.queueStatuses || [], null, 2));
        console.log('queueTransitions:');
        console.log(JSON.stringify(q.queueTransitions || [], null, 2));
      }
    }
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
