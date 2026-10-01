// QA's queue has queueStatuses (6) but ZERO queueTransitions -- meaning
// EVERY QA-department ticket's "Move to status" dropdown has been falling
// back to the generic site-wide status list (explaining the mismatched
// options seen on CF-33303: "Routed to Dev" from a ticket sitting in QA
// makes no sense as a real QA transition). Dumps QA's full queueStatuses
// list so a correct, complete queueTransitions set can be built to match
// it, mirroring the all-to-all pattern already used by Dev/Migration/
// Pre-Sales (every non-done status can reach every other status, plus a
// path to Resolved).
//
// Read-only.
//
// Usage: node check-qa-queue-statuses.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = rows[0]?.queues || [];
  const qa = queues.find((q) => (q.name || '').toLowerCase() === 'qa');
  if (!qa) { console.log('QA queue not found'); await pool.end(); return; }

  console.log(`QA queue id: ${qa.id}`);
  console.log('\nqueueStatuses:');
  for (const s of (qa.queueStatuses || [])) console.log(`  id=${s.id} name="${s.name}" category=${s.category} color=${s.color} order=${s.order}`);
  console.log(`\nqueueTransitions: ${JSON.stringify(qa.queueTransitions)}`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
