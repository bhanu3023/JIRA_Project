// My earlier isResolved consistency guard only affects the SECOND OR branch
// (deptStatusCategory === 'done' fallback) -- if a ticket's REAL global
// statusId directly reads a done-category status, isResolved is true via
// the FIRST branch (issue.status?.category === 'done') regardless of that
// guard. CF-29397's visible history shows its status explicitly set to
// "Waiting for Migration" (not done) at the moment it entered Migration,
// yet it still shows as falseResolvedDept after a forced recompute -- this
// checks whether its REAL current statusId/category actually says done
// right now, which would mean something silently overwrote it back to done
// after that reopen, without ever pausing Migration's own SLA clock.
// Read-only.
//
// Usage: node check-cf29397-real-status.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'CF-29397';

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, i.key, i.cf_key, i."statusId", i.current_department, i.dept_statuses, i.dept_sla_log,
           s.name AS status_name, s.category AS status_category
    FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE i.cf_key = $1 OR i.key = $1 LIMIT 1
  `, [KEY]);
  const issue = rows[0];
  if (!issue) { console.log(`${KEY} not found`); await pool.end(); return; }

  console.log(`=== ${KEY} ===`);
  console.log('REAL statusId:', issue.statusId, ' name:', issue.status_name, ' category:', issue.status_category);
  console.log('current_department:', issue.current_department);
  console.log('dept_statuses:', JSON.stringify(issue.dept_statuses, null, 2));
  console.log('dept_sla_log[current dept]:', JSON.stringify(issue.dept_sla_log?.[issue.current_department] || issue.dept_sla_log, null, 2));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
