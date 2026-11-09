// Read-only diagnostic for CF-35078: the ticket detail page's sidebar shows
// Department: Migration, but the mandatory-worklog-gate error said "Log
// work against this ticket in QA" -- find out what the DB actually has for
// current_department, dept_statuses, issue.updatedAt, and each worklog
// entry's department + createdAt relative to that, to see exactly why the
// gate is firing (or misfiring).
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT id, key, current_department, dept_statuses, "statusId", "updatedAt"
     FROM issues WHERE key = 'CF-35078' OR cf_key = 'CF-35078' LIMIT 1`,
  );
  const issue = rows[0];
  if (!issue) { console.log('CF-35078 not found'); await pool.end(); return; }
  console.log('issue.id:', issue.id);
  console.log('current_department:', issue.current_department);
  console.log('statusId:', issue.statusId);
  console.log('issue.updatedAt:', issue.updatedAt);
  console.log('dept_statuses:', JSON.stringify(issue.dept_statuses, null, 2));

  const st = await pool.query(`SELECT id, name, category FROM statuses WHERE id = $1`, [issue.statusId]);
  console.log('Real status row for statusId:', st.rows[0]);

  const wl = await pool.query(
    `SELECT id, department, "timeSpentMinutes", "authorName", "createdAt",
       ("createdAt" > $2) AS fresher_than_issue_updatedAt
     FROM issue_worklogs WHERE "issueId" = $1 ORDER BY "createdAt" ASC`,
    [issue.id, issue.updatedAt],
  );
  console.log(`\nWorklogs (${wl.rows.length}):`);
  for (const w of wl.rows) {
    console.log(`  [${w.department}] ${w.timeSpentMinutes}m by ${w.authorName} at ${w.createdAt.toISOString()} -- fresher than issue.updatedAt? ${w.fresher_than_issue_updatedAt}`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
