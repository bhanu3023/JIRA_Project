// Read-only: CF-34521's detail page shows a RUNNING SLA with 3h28m
// remaining (not breached), but the Filters export shows SLA Breached=Yes
// and Overdue=Yes. Checks the raw dueDate field against now -- suspected
// cause: computeSlaBreachedAndOverdue's early `if (!isResolved && i.dueDate
// && dueDate < now) breached = true` trigger, which uses the ticket's
// generic dueDate column (can go stale independent of the live per-dept SLA
// clock) to ALSO set the "SLA Breached" verdict, not just "Overdue" (which
// is what that field is actually meant for).
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const { rows } = await pool.query(
    `SELECT i.key, i.cf_key, i."dueDate", i.priority, i.current_department, i.dept_sla_log, i.dept_sla_started_at,
            s.name AS status_name, s.category AS status_category
     FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
     WHERE i.cf_key = 'CF-34521' OR i.key = 'CF-34521'`
  );
  const r = rows[0];
  const now = new Date();
  console.log('now:', now.toISOString());
  console.log('dueDate:', r.dueDate, '| dueDate < now ?', r.dueDate ? new Date(r.dueDate).getTime() < now.getTime() : 'no dueDate');
  console.log('priority:', r.priority, '| current_department:', r.current_department, '| status:', r.status_name, r.status_category);
  console.log('dept_sla_started_at:', r.dept_sla_started_at);
  console.log('dept_sla_log:', JSON.stringify(r.dept_sla_log));
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
