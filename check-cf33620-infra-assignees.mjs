// Read-only: CF-33620, Infra -- two people (Anish, Mubeen) reportedly worked
// on this ticket, but Filters' Assignee filter only surfaces it under one of
// them. Pull the raw assignee history, dept_assignees snapshot, worklog
// entries, and current assigneeId to see who actually touched it and how
// the Filters assignee match is scoped.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i."assigneeId", u."firstName" AS "currentAssigneeFirst", u."lastName" AS "currentAssigneeLast",
           i.dept_assignees, i.current_department, i.dept_sla_log
    FROM issues i LEFT JOIN users u ON u.id = i."assigneeId"
    WHERE i.cf_key = 'CF-33620' OR i.key = 'CF-33620'
  `);
  const r = rows[0];
  console.log('Current assignee:', r.currentAssigneeFirst, r.currentAssigneeLast, `(${r.assigneeId})`);
  console.log('current_department:', r.current_department);
  console.log('\ndept_assignees:', JSON.stringify(r.dept_assignees, null, 2));
  console.log('\ndept_sla_log.Infra:', JSON.stringify(r.dept_sla_log?.Infra, null, 2));

  const { rows: assigneeHist } = await pool.query(`
    SELECT "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
    WHERE "issueId" = $1 AND field = 'assignee' ORDER BY "createdAt" ASC
  `, [r.id]);
  console.log('\nAssignee change history:');
  for (const h of assigneeHist) console.log(`  [${h.createdAt.toISOString()}] ${h.authorName}: ${h.oldValue} -> ${h.newValue}`);

  const { rows: deptHist } = await pool.query(`
    SELECT "oldValue", "newValue", "createdAt" FROM issue_history
    WHERE "issueId" = $1 AND field = 'department' ORDER BY "createdAt" ASC
  `, [r.id]);
  console.log('\nDepartment change history:');
  for (const h of deptHist) console.log(`  [${h.createdAt.toISOString()}] ${h.oldValue} -> ${h.newValue}`);

  const { rows: worklogs } = await pool.query(`
    SELECT department, "timeSpentMinutes", "authorName", "workDate" FROM issue_worklogs WHERE "issueId" = $1 ORDER BY "workDate" ASC
  `, [r.id]);
  console.log('\nWorklog entries:');
  for (const w of worklogs) console.log(`  ${w.department}: ${w.authorName} logged ${w.timeSpentMinutes}min on ${w.workDate.toISOString().slice(0,10)}`);

  const { rows: statusHist } = await pool.query(`
    SELECT "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
    WHERE "issueId" = $1 AND field = 'status' ORDER BY "createdAt" ASC
  `, [r.id]);
  console.log('\nStatus change history (who touched it):');
  for (const h of statusHist) console.log(`  [${h.createdAt.toISOString()}] ${h.authorName}: ${h.oldValue} -> ${h.newValue}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
