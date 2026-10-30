// Read-only: full detail on CF-33837 and CF-33699 (counted as Dev-breached
// by Filters, not counted by MBR's eng tab) to find exactly which condition
// in MBR's per-ticket loop (deptMatchSql/rosterMatchSql/computeSLAInstancesPure)
// excludes them.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  for (const key of ['CF-33837', 'CF-33699', 'CF-34598', 'CF-34629']) {
    const { rows } = await pool.query(`
      SELECT i.id, i.key, i.cf_key, i.current_department, i.original_dept, i."assigneeId",
             s.name AS status_name, s.category AS status_category,
             i.dept_sla_log, i.dept_statuses, i."resolvedAt", i."createdAt",
             (SELECT email FROM users WHERE id = i."assigneeId") AS assignee_email
      FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
      WHERE i.cf_key = $1 OR i.key = $1
    `, [key]);
    const r = rows[0];
    if (!r) { console.log(`${key}: not found`); continue; }
    console.log(`\n${key} (${r.key}):`);
    console.log(`  current_department=${r.current_department} original_dept=${r.original_dept} status="${r.status_name}"(${r.status_category}) assignee=${r.assignee_email}`);
    console.log(`  dept_sla_log=${JSON.stringify(r.dept_sla_log)}`);
    console.log(`  resolvedAt=${r.resolvedAt}`);

    const { rows: worked } = await pool.query(
      `SELECT w.dept, w.reason, wu.email FROM user_worked_on_tickets w LEFT JOIN users wu ON wu.id = w.user_id WHERE w.issue_id = $1`,
      [r.id]
    );
    console.log(`  worked_on_tickets: ${JSON.stringify(worked)}`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
