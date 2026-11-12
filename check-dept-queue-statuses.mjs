// Read-only diagnostic: dump the full queueStatuses list for Dev, Migration,
// Infra, QA and Pre-Sales-Team on CloudFuze Board (TESTIN), so the upcoming
// "Routed to X" additions/removals land on exact, current data.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';
const TARGET_QUEUES = ['dev', 'migration', 'infra', 'qa', 'pre-sales-team'];

async function main() {
  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  let queues = cqRows[0]?.queues || [];
  if (typeof queues === 'string') { try { queues = JSON.parse(queues); } catch {} }

  for (const q of queues) {
    if (!TARGET_QUEUES.includes((q.name || '').toLowerCase())) continue;
    console.log(`\n=== Queue: "${q.name}" (id=${q.id}) ===`);
    console.log(`members: ${JSON.stringify(q.memberIds)}`);
    const statuses = q.queueStatuses || [];
    if (!statuses.length) { console.log('  (no custom queueStatuses)'); continue; }
    for (const s of statuses) {
      console.log(`  - id=${s.id}  name="${s.name}"  category=${s.category}  color=${s.color}  order=${s.order}`);
    }
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
