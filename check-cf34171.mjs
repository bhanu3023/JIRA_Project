// Read-only: CF-34171's "Breached by Sujana Manapuram" on the Dev SLA card
// looks wrong per the user. Dump dept_assignees (the snapshot the SlaPanel's
// "Breached by" reads from for a historical/paused department), dept_sla_log,
// and the full assignee-change history to find out who actually held it in
// Dev when that department's own clock ran out.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT id, key, cf_key, current_department, original_dept, "assigneeId",
            dept_assignees, dept_sla_log, dept_statuses, "createdAt", "resolvedAt"
     FROM issues WHERE key = 'CF-34171' OR cf_key = 'CF-34171'`
  );
  const issue = rows[0];
  if (!issue) { console.log('Issue not found'); await pool.end(); return; }
  console.log('current_department:', issue.current_department, '| original_dept:', issue.original_dept);
  console.log('\ndept_assignees:', JSON.stringify(issue.dept_assignees, null, 2));
  console.log('\ndept_sla_log:', JSON.stringify(issue.dept_sla_log, null, 2));

  const { rows: assigneeHistory } = await pool.query(
    `SELECT h."oldValue", h."newValue", h."authorName", h."createdAt"
     FROM issue_history h WHERE h."issueId" = $1 AND h.field = 'assignee'
     ORDER BY h."createdAt" ASC`,
    [issue.id]
  );
  console.log('\nAssignee change history:');
  for (const h of assigneeHistory) console.log(` - ${h.createdAt.toISOString()} | ${h.oldValue || 'None'} -> ${h.newValue || 'None'} (by ${h.authorName})`);

  const { rows: deptHistory } = await pool.query(
    `SELECT h."oldValue", h."newValue", h."authorName", h."createdAt"
     FROM issue_history h WHERE h."issueId" = $1 AND h.field IN ('department','current_department')
     ORDER BY h."createdAt" ASC`,
    [issue.id]
  );
  console.log('\nDepartment change history:');
  for (const h of deptHistory) console.log(` - ${h.createdAt.toISOString()} | ${h.oldValue || 'None'} -> ${h.newValue || 'None'} (by ${h.authorName})`);

  if (issue.assigneeId) {
    const { rows: u } = await pool.query(`SELECT "firstName","lastName" FROM users WHERE id=$1`, [issue.assigneeId]);
    console.log('\nCurrent live assignee:', u[0]);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
