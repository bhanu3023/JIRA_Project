// Read-only: CF-33117's History shows Mayank Jain being UNASSIGNED
// (Mayank Jain -> None) at the same moment the ticket got routed to QA, and
// QA's SLA has been live-breaching, unassigned, ever since. Filters
// apparently still shows Mayank Jain's name against this ticket. Check the
// REAL current assigneeId/current_department/dept_assignees to see whether
// the DB itself is stale (still pointing to Mayank) or whether Filters is
// reading the wrong field entirely.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT COALESCE(i.cf_key, i.key) AS key, i."assigneeId", au.email AS assignee_email,
           au."firstName" AS assignee_first, au."lastName" AS assignee_last,
           i.current_department, i.dept_assignees, i.dept_sla_log, i."resolvedAt", i.priority
    FROM issues i LEFT JOIN users au ON au.id = i."assigneeId"
    WHERE i.cf_key = 'CF-33117' OR i.key = 'CF-33117'
  `);
  const r = rows[0];
  console.log('Real current assigneeId:', r.assigneeId, '-> ', r.assignee_first, r.assignee_last, `(${r.assignee_email})`);
  console.log('current_department:', r.current_department);
  console.log('resolvedAt:', r.resolvedAt);
  console.log('priority:', r.priority);
  console.log('\ndept_assignees:', JSON.stringify(r.dept_assignees, null, 2));
  console.log('\ndept_sla_log.QA:', JSON.stringify(r.dept_sla_log?.QA, null, 2));

  // Last few assignee-change history rows, to confirm what the History tab shows
  const { rows: hist } = await pool.query(`
    SELECT h."oldValue", h."newValue", h."authorName", h."createdAt"
    FROM issue_history h JOIN issues i ON i.id = h."issueId"
    WHERE (i.cf_key = 'CF-33117' OR i.key = 'CF-33117') AND h.field = 'assignee'
    ORDER BY h."createdAt" ASC
  `);
  console.log('\nFull assignee history:');
  for (const h of hist) console.log(` - [${h.createdAt.toISOString()}] ${h.oldValue} -> ${h.newValue} (by ${h.authorName})`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
