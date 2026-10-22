// Read-only: does each of Dev/QA/Infra/Migration have its own populated
// queueStatuses (per-queue custom list), or is it empty/relying on the
// space-wide `statuses` table? Determines whether "Routed to AI" needs to
// be added per-queue or as one shared space-wide status row.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';
const TARGET_QUEUES = ['Dev', 'QA', 'Infra', 'Migration'];

async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = rows[0]?.queues || [];

  for (const name of TARGET_QUEUES) {
    const q = queues.find((qq) => (qq.name || '').toLowerCase() === name.toLowerCase());
    if (!q) { console.log(`"${name}": QUEUE NOT FOUND`); continue; }
    const qs = q.queueStatuses || [];
    console.log(`"${name}": ${qs.length} queueStatuses${qs.length ? ':' : ' (empty -- relies on space-wide statuses table)'}`);
    for (const s of qs) console.log(`    ${s.id} "${s.name}" (${s.category})`);
  }

  const aiQ = queues.find((qq) => (qq.name || '').toLowerCase() === 'ai');
  console.log(`\n"AI" queue exists: ${!!aiQ}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
