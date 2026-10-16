// Backfills user_worked_on_tickets for tickets that have ZERO rows there at
// all -- these are invisible to every workedRange-based Filters query no
// matter what flags are set, which is why older months (before certain
// handoff paths started logging worked-on credit reliably) undercount
// relative to MBR's current-assignee-based "Total tickets".
//
// For each such ticket, reconstructs one row per department it actually
// visited using the data already recorded for it:
//   - dept_sla_log's keys = every department this ticket was ever in, with
//     its own started_at/paused_at/elapsed_ms already tracked there.
//   - dept_assignees[dept] = that department's own frozen assignee
//     snapshot (who held it while it sat there) -- the SAME source the
//     "Showing <dept>'s own assignee" banner and historical SLA cards
//     already read from, so this uses no new/unproven data.
//   - Falls back to the ticket's own current assigneeId only for its
//     CURRENT department, when no dept_assignees snapshot exists for it.
// reason: 'closed' if the ticket is resolved, else 'worked' -- matching
// the existing reason vocabulary this table already uses elsewhere.
// worked_at: that department's own paused_at (if it moved on) or
// started_at (if it's still there / never explicitly paused) -- always a
// real recorded timestamp for that specific department visit, never
// "now" or the ticket's own createdAt.
//
// Narrow and additive: only ever INSERTs for a ticket that currently has
// ZERO rows in this table (confirmed by check-worked-on-coverage.mjs) --
// never touches a ticket that already has real worked-on data, so it can't
// overwrite or conflict with anything already correct.
//
// Usage: node backfill-missing-worked-on-rows.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: issues } = await pool.query(`
    SELECT i.id, i.key, i.cf_key, i."assigneeId", i.current_department, i.dept_sla_log, i.dept_assignees,
           (s.category = 'done') AS is_resolved
    FROM issues i
    LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE i."spaceId" = (SELECT id FROM spaces WHERE key = 'TESTIN')
      AND (LOWER(i.current_department) = 'dev' OR i.dept_sla_log ? 'Dev' OR i.dept_sla_log ? 'dev')
      AND NOT EXISTS (SELECT 1 FROM user_worked_on_tickets w WHERE w.issue_id = i.id)
  `);
  console.log(`Found ${issues.length} Dev-related tickets with zero worked-on rows.`);

  let inserted = 0, skipped = 0;
  for (const issue of issues) {
    const deptLog = issue.dept_sla_log || {};
    const deptAssignees = issue.dept_assignees || {};
    const depts = Object.keys(deptLog).length ? Object.keys(deptLog) : (issue.current_department ? [issue.current_department] : []);
    const reason = issue.is_resolved ? 'closed' : 'worked';
    let anyForThisTicket = false;

    for (const dept of depts) {
      const entry = deptLog[dept] || {};
      const isCurrentDept = (issue.current_department || '').trim().toLowerCase() === dept.trim().toLowerCase();
      const assigneeKey = Object.keys(deptAssignees).find((k) => k.toLowerCase() === dept.toLowerCase());
      const deptAssigneeId = assigneeKey ? deptAssignees[assigneeKey]?.id : null;
      const userId = deptAssigneeId || (isCurrentDept ? issue.assigneeId : null);
      if (!userId) continue; // no one to credit for this department visit -- skip it, not a guess
      const workedAt = entry.paused_at || entry.started_at || null;
      if (!workedAt) continue; // no real timestamp to anchor this to -- skip rather than fabricate one

      await pool.query(
        `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason, worked_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, issue_id, dept) DO NOTHING`,
        [userId, issue.id, dept, reason, workedAt]
      );
      inserted++;
      anyForThisTicket = true;
    }
    if (!anyForThisTicket) skipped++;
  }

  console.log(`\nInserted ${inserted} row(s) across ${issues.length} ticket(s).`);
  console.log(`${skipped} ticket(s) had no usable assignee/timestamp data to reconstruct from, left untouched.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
