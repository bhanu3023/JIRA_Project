// The "Worked on" tab (GET /worked-on) and every "Worked" date-range filter
// in Filters/Team Analytics/MBR are 100% driven by rows in
// user_worked_on_tickets -- a row only ever gets inserted by a real in-app
// action (closing a ticket, passing it to another department). A ticket
// bulk-migrated from the old Jira system already resolved, or otherwise
// closed before this credit-tracking table existed, has zero such rows and
// is permanently invisible under anyone's "Worked on" tab no matter who
// actually did the work -- confirmed structurally correct per the user's
// report of missing tickets across Dev/Migration/Infra/QA with no date
// pattern to it.
//
// Backfills a 'closed' credit for every department a ticket shows as
// actually done in, crediting:
//   - that department's OWN saved assignee (dept_assignees[dept]) when one
//     was snapshotted, else
//   - the ticket's current live assigneeId, but ONLY when that dept IS the
//     ticket's current department (a moved-on department's assignee can't
//     be safely guessed if it was never snapshotted -- skipped instead of
//     guessing wrong).
// A ticket with no per-department snapshot at all (very old/simple tickets
// that predate dept_statuses) falls back to its plain global status +
// current department + current assignee.
//
// worked_at is backfilled from the ticket's own resolvedAt/updatedAt/
// createdAt (in that preference order), NOT "now" -- using now() would make
// every migrated ticket suddenly appear as worked today in any date-ranged
// "Worked" view, which is exactly the kind of wrong data this is fixing.
//
// Never touches a (user, issue, dept) combination that already has a row --
// existing real credit (any reason) is left completely alone; this only
// fills in gaps.
//
// Usage:
//   node backfill-worked-on-credit.mjs           # dry run
//   node backfill-worked-on-credit.mjs --apply   # writes the credits

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function deptMapGet(map, dept) {
  const key = Object.keys(map).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  return key ? map[key] : undefined;
}

async function main() {
  const { rows: issues } = await pool.query(`
    SELECT id, cf_key, key, current_department, "assigneeId", dept_statuses, dept_assignees,
           "statusId", "resolvedAt", "updatedAt", "createdAt"
    FROM issues
  `);
  const { rows: statusRows } = await pool.query(`SELECT id, category FROM statuses`);
  const statusCategoryById = new Map(statusRows.map((s) => [s.id, s.category]));

  const { rows: existingRows } = await pool.query(`SELECT user_id, issue_id, dept FROM user_worked_on_tickets`);
  const existingSet = new Set(existingRows.map((r) => `${r.user_id}::${r.issue_id}::${(r.dept || '').toLowerCase()}`));

  const toInsert = [];
  const deptCounts = {};
  const skippedNoAssignee = [];

  for (const issue of issues) {
    const deptStatuses = issue.dept_statuses || {};
    const deptAssignees = issue.dept_assignees || {};
    const entries = Object.entries(deptStatuses);
    const workedAt = issue.resolvedAt || issue.updatedAt || issue.createdAt;

    if (entries.length === 0) {
      const cat = statusCategoryById.get(issue.statusId);
      if (cat === 'done' && issue.assigneeId && issue.current_department) {
        const dept = issue.current_department;
        const k = `${issue.assigneeId}::${issue.id}::${dept.toLowerCase()}`;
        if (!existingSet.has(k)) {
          toInsert.push({ user_id: issue.assigneeId, issue_id: issue.id, dept, cf_key: issue.cf_key || issue.key, workedAt });
          existingSet.add(k);
          deptCounts[dept] = (deptCounts[dept] || 0) + 1;
        }
      }
      continue;
    }

    for (const [dept, st] of entries) {
      if (!st || st.category !== 'done') continue;
      const snap = deptMapGet(deptAssignees, dept);
      let assigneeId = snap?.id || null;
      if (!assigneeId && dept.toLowerCase() === (issue.current_department || '').toLowerCase()) {
        assigneeId = issue.assigneeId;
      }
      if (!assigneeId) { skippedNoAssignee.push(`${issue.cf_key || issue.key} [${dept}]`); continue; }
      const k = `${assigneeId}::${issue.id}::${dept.toLowerCase()}`;
      if (existingSet.has(k)) continue;
      toInsert.push({ user_id: assigneeId, issue_id: issue.id, dept, cf_key: issue.cf_key || issue.key, workedAt });
      existingSet.add(k);
      deptCounts[dept] = (deptCounts[dept] || 0) + 1;
    }
  }

  console.log(`Scanned ${issues.length} issues.`);
  console.log(`\nWould insert ${toInsert.length} new 'closed' worked-on credit(s) by department:`);
  for (const [dept, count] of Object.entries(deptCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${dept}: ${count}`);
  }
  console.log(`\nSkipped ${skippedNoAssignee.length} done-department snapshot(s) with no resolvable assignee (never snapshotted for that dept, and it's not the ticket's current department either -- can't safely guess who). Sample:`);
  for (const s of skippedNoAssignee.slice(0, 20)) console.log(`  ${s}`);
  if (skippedNoAssignee.length > 20) console.log(`  ... and ${skippedNoAssignee.length - 20} more.`);

  console.log(`\nSample of inserts (first 20):`);
  for (const ins of toInsert.slice(0, 20)) console.log(`  ${ins.cf_key} [${ins.dept}] -> user ${ins.user_id}  (worked_at: ${ins.workedAt ? new Date(ins.workedAt).toISOString() : 'null'})`);
  if (toInsert.length > 20) console.log(`  ... and ${toInsert.length - 20} more.`);

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to write these ${toInsert.length} credit(s).`);
    await pool.end();
    return;
  }

  let written = 0;
  for (const ins of toInsert) {
    await pool.query(
      `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason, worked_at) VALUES ($1,$2,$3,'closed',$4)
       ON CONFLICT (user_id, issue_id, dept) DO NOTHING`,
      [ins.user_id, ins.issue_id, ins.dept, ins.workedAt || new Date()]
    );
    written++;
    if (written % 500 === 0) console.log(`  ...${written}/${toInsert.length}`);
  }
  console.log(`\nInserted ${written} worked-on credit(s).`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
