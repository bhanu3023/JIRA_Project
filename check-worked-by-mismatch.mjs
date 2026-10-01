// Checks whether MBR's "worked by X" credit for a specific ticket is
// backed by real evidence -- CF-29950's own resolution history shows
// "Shivam Singh" worked it, but MBR's Customer Engineering drill-down
// credited "Shiva Amuda" instead (similar names, different people).
// Confirms whether this is a genuine data bug (wrong user_id stored) or
// both people legitimately touched the ticket at different times.
//
// Read-only.
//
// Usage: node check-worked-by-mismatch.mjs <CF-KEY>

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = process.argv[2];

if (!KEY) {
  console.error('Usage: node check-worked-by-mismatch.mjs <CF-KEY>');
  process.exit(1);
}

async function main() {
  const { rows: issueRows } = await pool.query(
    `SELECT id, COALESCE(cf_key, key) AS key, current_department, dept_assignees FROM issues WHERE cf_key = $1 OR key = $1`,
    [KEY]
  );
  if (!issueRows.length) { console.log('Not found'); await pool.end(); return; }
  const issue = issueRows[0];
  console.log(`${issue.key}  current_department=${issue.current_department}\n`);

  console.log('dept_assignees snapshot:', JSON.stringify(issue.dept_assignees));

  console.log('\nuser_worked_on_tickets rows for this issue:');
  const { rows: worked } = await pool.query(
    `SELECT w.user_id, wu.email, wu."firstName", wu."lastName", w.dept, w.reason, w.worked_at
     FROM user_worked_on_tickets w JOIN users wu ON wu.id = w.user_id
     WHERE w.issue_id = $1
     ORDER BY w.worked_at ASC`,
    [issue.id]
  );
  for (const w of worked) {
    console.log(`  ${w.firstName} ${w.lastName} <${w.email}>  dept=${w.dept}  reason=${w.reason}  worked_at=${w.worked_at?.toISOString()}`);
  }

  console.log('\nissue_history rows (assignee + status fields) for this issue:');
  const { rows: hist } = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
     WHERE "issueId" = $1 AND field IN ('assignee','status') ORDER BY "createdAt" ASC`,
    [issue.id]
  );
  for (const h of hist) {
    console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}"  (by ${h.authorName})`);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
