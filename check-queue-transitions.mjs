// Read-only: for each of Dev/QA/Infra/Migration, show queueStatuses (with
// ids) and queueTransitions, so we can see the exact pattern used to allow
// "Routed to X" moves -- the dropdown on the issue page only offers a
// status as a destination when an explicit {from, to} transition exists
// for the ticket's CURRENT status, not just because the status exists.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';
const TARGET_QUEUES = ['Dev', 'QA', 'Infra', 'Migration'];

async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = rows[0]?.queues || [];

  for (const name of TARGET_QUEUES) {
    const q = queues.find((qq) => (qq.name || '').toLowerCase() === name.toLowerCase());
    if (!q) continue;
    const statuses = q.queueStatuses || [];
    const byId = Object.fromEntries(statuses.map((s) => [s.id, s.name]));
    const transitions = q.queueTransitions || [];
    console.log(`\n=== "${name}" ===`);
    console.log('Statuses:', statuses.map((s) => `${s.id}="${s.name}"`).join(', '));
    console.log(`Transitions (${transitions.length}):`);
    for (const t of transitions) {
      const fromId = t.fromStatusId ?? t.from;
      const toId = t.toStatusId ?? t.to;
      console.log(`  [raw keys: ${Object.keys(t).join(',')}]  ${byId[fromId] || fromId} (${fromId}) -> ${byId[toId] || toId} (${toId})`);
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
