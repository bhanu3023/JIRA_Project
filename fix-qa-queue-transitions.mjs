// Two real bugs found investigating CF-33303 (now in QA department):
// 1. QA's queueTransitions is completely missing (undefined) -- every
//    QA-department ticket's "Move to status" dropdown has been silently
//    falling back to the generic site-wide status list instead of QA's
//    own real transitions, ever since this queue was set up.
// 2. QA never got a "Routed to Pre-sales" status added at all, unlike
//    Dev/Infra/Migration, which all already have one.
//
// Adds qst_qa_waitingpresales to QA's queueStatuses (matching Dev's exact
// naming/color/category convention), then builds a complete transition set
// -- every ordered pair among all 7 statuses (Open, In Progress, Routed to
// Dev/Infra/Migration/Pre-sales, Resolved) -- so nothing is silently
// unreachable, matching the fully-populated pattern already used by
// Migration and Pre-Sales' own queues.
//
// Usage: node fix-qa-queue-transitions.mjs [--apply]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = rows[0]?.queues || [];
  const qaIdx = queues.findIndex((q) => (q.name || '').toLowerCase() === 'qa');
  if (qaIdx === -1) { console.log('QA queue not found'); await pool.end(); return; }
  const qa = queues[qaIdx];

  const hasPresales = (qa.queueStatuses || []).some((s) => s.id === 'qst_qa_waitingpresales');
  const newStatuses = hasPresales ? qa.queueStatuses : [
    ...qa.queueStatuses,
    { id: 'qst_qa_waitingpresales', name: 'Routed to Pre-sales', category: 'in_progress', color: '#F59E0B', order: qa.queueStatuses.length },
  ];

  const transitions = [];
  for (const from of newStatuses) {
    for (const to of newStatuses) {
      if (from.id === to.id) continue;
      transitions.push({ fromStatusId: from.id, toStatusId: to.id });
    }
  }

  console.log('New queueStatuses:');
  for (const s of newStatuses) console.log(`  ${s.id} "${s.name}"`);
  console.log(`\nBuilt ${transitions.length} transitions (complete graph over ${newStatuses.length} statuses).`);

  if (APPLY) {
    queues[qaIdx] = { ...qa, queueStatuses: newStatuses, queueTransitions: transitions };
    await pool.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = 'TESTIN'`, [JSON.stringify(queues)]);
    console.log('\nApplied.');
  } else {
    console.log('\n(dry run -- re-run with --apply)');
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
