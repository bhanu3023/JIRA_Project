import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';
const QUEUE_NAME = 'Pre-sales';
async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = rows[0]?.queues || [];
  console.log('All queue names:', queues.map((q) => q.name));
  const q = queues.find((qq) => (qq.name || '').toLowerCase() === QUEUE_NAME.toLowerCase());
  if (!q) { console.log(`"${QUEUE_NAME}" not found`); await pool.end(); return; }
  const statuses = q.queueStatuses || [];
  const byId = Object.fromEntries(statuses.map((s) => [s.id, s.name]));
  const transitions = q.queueTransitions || [];
  console.log(`\n"${q.name}" statuses (${statuses.length}):`, statuses.map((s) => `${s.id}="${s.name}"`));
  console.log(`Transitions (${transitions.length}):`);
  for (const t of transitions) {
    const fromId = t.fromStatusId ?? t.from;
    const toId = t.toStatusId ?? t.to;
    console.log(`  ${byId[fromId] || fromId} -> ${byId[toId] || toId}`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
