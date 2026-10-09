// CF-31525 shows up in MBR's Infra tab but not Filters' Queue: Infra for
// Sep 2026 (665 vs 664) -- Infra uses the same unmodified deptMatchSql/
// rosterMatchSql code path that already proved exact for Dev and QA, so
// this is likely a single edge-case ticket rather than a systemic gap.
// Pulls its full department/worked-on/history picture directly. Read-only.
//
// Usage: node check-cf31525-infra.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'CF-31525';

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, i.key, i.cf_key, i.current_department, i.original_dept, i.dept_statuses,
           i."createdAt", i."updatedAt", u.email AS assignee_email
    FROM issues i LEFT JOIN users u ON u.id = i."assigneeId"
    WHERE i.cf_key = $1 OR i.key = $1 LIMIT 1
  `, [KEY]);
  const issue = rows[0];
  if (!issue) { console.log(`${KEY} not found`); await pool.end(); return; }

  console.log(`=== ${KEY} ===`);
  console.log('current_department:', issue.current_department);
  console.log('original_dept:', issue.original_dept);
  console.log('dept_statuses:', JSON.stringify(issue.dept_statuses));
  console.log('assignee:', issue.assignee_email);
  console.log('createdAt:', issue.createdAt);
  console.log('updatedAt:', issue.updatedAt);

  const { rows: workedRows } = await pool.query(`
    SELECT w.dept, w.reason, wu.email AS worker_email, w.worked_at
    FROM user_worked_on_tickets w LEFT JOIN users wu ON wu.id = w.user_id
    WHERE w.issue_id = $1 ORDER BY w.worked_at ASC
  `, [issue.id]);
  console.log('\n=== user_worked_on_tickets ===');
  for (const r of workedRows) console.log(`  dept=${r.dept} reason=${r.reason} worker=${r.worker_email || 'null'} at=${r.worked_at?.toISOString?.()}`);

  const { rows: history } = await pool.query(`
    SELECT field, "oldValue", "newValue", "createdAt" FROM issue_history
    WHERE "issueId" = $1 AND field IN ('department','status') ORDER BY "createdAt" ASC
  `, [issue.id]);
  console.log('\n=== department/status history ===');
  for (const h of history) console.log(`  ${h.createdAt.toISOString()} [${h.field}] ${h.oldValue} -> ${h.newValue}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
