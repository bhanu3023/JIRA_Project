// Adds a "Deferred" status to ONLY the Dev queue (cq_1783689426143) in the
// TESTIN space's custom_queues config -- confirmed via check-dev-queue-statuses.mjs
// to be the only queue literally named "Dev" in the system. Every other
// queue (Migration, QA, Infra, ...), in TESTIN or any other space, is
// untouched: queueStatuses lives per-queue, so this never leaks into them.
// Dry-run by default -- pass --apply to write.
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const SPACE_KEY = 'TESTIN';
const QUEUE_ID = 'cq_1783689426143';
const STATUS_NAME = 'Deferred';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  if (!rows.length) { console.error(`No custom_queues row for space ${SPACE_KEY}`); await pool.end(); process.exit(1); }

  const queues = rows[0].queues || [];
  const queue = queues.find((q) => q.id === QUEUE_ID);
  if (!queue) { console.error(`Queue ${QUEUE_ID} not found in ${SPACE_KEY}`); await pool.end(); process.exit(1); }

  console.log(`Found queue "${queue.name}" (${QUEUE_ID}) in space ${SPACE_KEY}.`);
  const statuses = queue.queueStatuses || [];
  const already = statuses.find((s) => String(s.name || '').trim().toLowerCase() === STATUS_NAME.toLowerCase());
  if (already) {
    console.log(`Already has a "${STATUS_NAME}" status (id: ${already.id}) -- nothing to do.`);
    await pool.end();
    return;
  }

  const newStatus = {
    id: `qst_dev_deferred`,
    name: STATUS_NAME,
    // Neutral grey, same family as the other non-done "Routed to ..."
    // statuses -- easy to recolor afterwards from Space > Dev queue >
    // Workflow, same place any of this is editable going forward.
    color: '#6b7280',
    category: 'todo',
    order: statuses.length,
  };
  const updatedStatuses = [...statuses, newStatus];
  console.log('\nWill add:', newStatus);
  console.log(`\nResulting status list for "${queue.name}":`, updatedStatuses.map((s) => s.name).join(', '));

  if (!APPLY) {
    console.log('\nDry run only -- rerun with --apply to actually save this.');
    await pool.end();
    return;
  }

  const updatedQueues = queues.map((q) => (q.id === QUEUE_ID ? { ...q, queueStatuses: updatedStatuses } : q));
  await pool.query(`UPDATE custom_queues SET queues = $1 WHERE space_key = $2`, [JSON.stringify(updatedQueues), SPACE_KEY]);
  console.log(`\nSaved. "${STATUS_NAME}" is now a status option for the Dev queue only.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
