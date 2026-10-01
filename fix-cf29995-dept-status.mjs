// CF-29995's dept_statuses.Pre-sales snapshot holds id="status_qa_inprogress"
// (QA's real status row, not one of Pre-Sales' own qst_presales_* ids) --
// getEffectiveIssueStatus only trusts a snapshot as a real queue status
// when its id starts with qst_, so this one silently falls back to the
// raw global status, which then can't match anything in Pre-Sales' own
// queueTransitions config (all keyed by qst_presales_* ids). Fixes the
// snapshot to use Pre-Sales' own "In Progress" queue-status id
// (qst_presales_inprogress) instead, keeping the same displayed name --
// this doesn't change the ticket's real global status or anything else,
// only which id Pre-Sales' own snapshot points at.
//
// Usage: node fix-cf29995-dept-status.mjs [--apply]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(
    `SELECT id, dept_statuses FROM issues WHERE cf_key = 'CF-29995' OR key = 'CF-29995'`
  );
  const issue = rows[0];
  console.log(`Current dept_statuses: ${JSON.stringify(issue.dept_statuses)}`);

  // Pull Pre-Sales' own "In Progress" queue-status object directly from
  // custom_queues, rather than hand-typing color/category, so this always
  // matches whatever that queue is actually configured with right now.
  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues`);
  let presalesInProgress = null;
  for (const row of cqRows) {
    const queues = Array.isArray(row.queues) ? row.queues : [];
    const q = queues.find((qq) => /pre.?sales/i.test(String(qq?.name || '')));
    if (q) presalesInProgress = (q.queueStatuses || []).find((s) => s.id === 'qst_presales_inprogress');
  }
  if (!presalesInProgress) { console.log('Could not find qst_presales_inprogress in the live queue config -- aborting.'); await pool.end(); return; }
  console.log(`Pre-Sales' real "In Progress" queue status: ${JSON.stringify(presalesInProgress)}`);

  const newDeptStatuses = { ...issue.dept_statuses, 'Pre-sales': { id: presalesInProgress.id, name: presalesInProgress.name, color: presalesInProgress.color, category: presalesInProgress.category } };
  console.log(`\n${APPLY ? 'Setting' : 'Would set'} dept_statuses to: ${JSON.stringify(newDeptStatuses)}`);
  if (APPLY) {
    await pool.query(`UPDATE issues SET dept_statuses = $1::jsonb WHERE id = $2`, [JSON.stringify(newDeptStatuses), issue.id]);
    console.log('Applied.');
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
