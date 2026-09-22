// Dev's queueStatuses DOES include "Routed to Pre-sales"
// (qst_dev_waitingpresales) and "Routed to QA" (qst_dev_waitingqa), but
// neither shows in CF-33303's dropdown (current status: In Progress).
// The dropdown filters queueTransitions to only those whose fromStatusId
// matches the CURRENT status -- so the status existing isn't enough if no
// transition rule allows reaching it from "In Progress". Lists every
// transition FROM qst_dev_inprogress to confirm exactly which targets are
// actually reachable.
//
// Read-only.
//
// Usage: node check-dev-inprogress-transitions.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = rows[0]?.queues || [];
  const dev = queues.find((q) => (q.name || '').toLowerCase() === 'dev');
  const statusById = new Map((dev.queueStatuses || []).map((s) => [s.id, s.name]));

  console.log('All transitions FROM "In Progress" (qst_dev_inprogress):');
  const fromInProgress = (dev.queueTransitions || []).filter((t) => (t.fromStatusId ?? t.from) === 'qst_dev_inprogress');
  for (const t of fromInProgress) {
    const toId = t.toStatusId ?? t.to;
    console.log(`  -> ${statusById.get(toId) || toId} (${toId})`);
  }
  console.log(`\nTotal: ${fromInProgress.length} transitions out of In Progress.`);

  console.log('\nFor comparison, ALL transitions targeting "Routed to Pre-sales" or "Routed to QA" (from any status):');
  for (const t of (dev.queueTransitions || [])) {
    const toId = t.toStatusId ?? t.to;
    if (toId === 'qst_dev_waitingpresales' || toId === 'qst_dev_waitingqa') {
      const fromId = t.fromStatusId ?? t.from;
      console.log(`  ${statusById.get(fromId) || fromId} -> ${statusById.get(toId) || toId}`);
    }
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
