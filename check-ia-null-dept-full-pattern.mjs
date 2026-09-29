// Confirmed: IT ADMINISTRATION's 30 tickets all have current_department =
// NULL. Checking the REST of the department-tracking fields on one of
// those tickets too (original_dept, dept_sla_started_at, dept_sla_log,
// dept_statuses) so CF-33655 can be brought in line with the FULL real
// pattern, not just current_department alone -- its SLA card is currently
// showing an actively "RUNNING" clock labeled Infra, which lives in
// dept_sla_log/dept_sla_started_at, not current_department.
//
// Read-only.
//
// Usage: node check-ia-null-dept-full-pattern.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT i.key, i.current_department, i.original_dept, i.dept_sla_started_at, i.dept_sla_log, i.dept_statuses, i.dept_assignees
     FROM issues i JOIN spaces sp ON sp.id = i."spaceId"
     WHERE sp.key = 'IA' LIMIT 3`
  );
  for (const r of rows) console.log(JSON.stringify(r, null, 2));

  console.log('\n--- CF-33655 (SAT_Board) current full state ---');
  const { rows: t } = await pool.query(
    `SELECT key, current_department, original_dept, dept_sla_started_at, dept_sla_log, dept_statuses, dept_assignees
     FROM issues WHERE key = 'CF-33655'`
  );
  console.log(JSON.stringify(t[0], null, 2));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
