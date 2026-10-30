// Read-only: CF-34234 is a Migration-department ticket with no History
// trace of ever touching Infra, yet shows up under a Queue: Infra Filters
// view with "SLA Breached: Yes" attributed to a Migration person's name.
// Dump everything relevant to find which broad-match condition is pulling
// it into the Infra queue incorrectly.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, COALESCE(i.cf_key,i.key) AS key, i.current_department, i.original_dept,
           i.dept_statuses, i.dept_sla_log, i.dept_assignees, i."assigneeId", i."spaceId",
           i.priority, i."resolvedAt", i.sla_snapshot, i.jira_sla_breached
    FROM issues i WHERE i.cf_key = 'CF-34234' OR i.key = 'CF-34234'
  `);
  const r = rows[0];
  console.log('current_department:', r.current_department);
  console.log('original_dept:', r.original_dept);
  console.log('priority:', r.priority, '| resolvedAt:', r.resolvedAt, '| jira_sla_breached:', r.jira_sla_breached);
  console.log('\ndept_statuses:', JSON.stringify(r.dept_statuses, null, 2));
  console.log('\ndept_sla_log:', JSON.stringify(r.dept_sla_log, null, 2));
  console.log('\ndept_assignees:', JSON.stringify(r.dept_assignees, null, 2));
  console.log('\nsla_snapshot:', JSON.stringify(r.sla_snapshot, null, 2));

  // Earliest department-history event (original routing)
  const { rows: deptHist } = await pool.query(`
    SELECT "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
    WHERE "issueId" = $1 AND field = 'department' ORDER BY "createdAt" ASC
  `, [r.id]);
  console.log('\nDepartment change history:');
  for (const h of deptHist) console.log(` - [${h.createdAt.toISOString()}] ${h.oldValue} -> ${h.newValue} (by ${h.authorName})`);

  // Is this ticket's assignee/reporter on Infra's live roster (would
  // explain a "worked-on" or "roster member" match)?
  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const infraQueue = (cq[0]?.queues || []).find((q) => String(q.name || '').toLowerCase() === 'infra');
  const { rows: memberRows } = await pool.query(
    `SELECT email FROM users WHERE id = ANY($1::text[])`,
    [infraQueue?.memberIds || []]
  );
  console.log('\nInfra roster emails:', memberRows.map((m) => m.email));

  const { rows: assignee } = await pool.query(`SELECT email, "firstName", "lastName" FROM users WHERE id = $1`, [r.assigneeId]);
  console.log('This ticket\'s real assignee:', assignee[0]);

  // Any user_worked_on_tickets row claiming Infra for this ticket?
  const { rows: worked } = await pool.query(`
    SELECT w.dept, w.reason, w.worked_at, u.email FROM user_worked_on_tickets w
    JOIN users u ON u.id = w.user_id WHERE w.issue_id = $1
  `, [r.id]);
  console.log('\nuser_worked_on_tickets rows for this ticket:', JSON.stringify(worked, null, 2));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
