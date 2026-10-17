// Read-only check: CF-34103 is showing a "Showing QA's own assignee --
// this ticket has since moved to Dev" banner to a Dev-queue user, which
// should only ever show to someone viewing via a QA-perspective link. This
// inspects every user_worked_on_tickets row for this ticket, to see if the
// same "wrong department after a handoff" bug (just fixed) created a bad
// QA-tagged row for the Dev user who's seeing this, or if this is a
// different cause (e.g. a stale link, or a pre-fix historical row).
//
// Usage: node check-cf34103-worked-rows.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'CF-34103';

async function main() {
  const { rows: issueRows } = await pool.query(`SELECT id, current_department FROM issues WHERE key=$1 OR cf_key=$1 LIMIT 1`, [KEY]);
  const issue = issueRows[0];
  if (!issue) { console.log(`${KEY} not found`); await pool.end(); return; }
  console.log(`${KEY} current_department: ${issue.current_department}\n`);

  const { rows } = await pool.query(`
    SELECT w.dept, w.reason, w.worked_at, u.email
    FROM user_worked_on_tickets w JOIN users u ON u.id = w.user_id
    WHERE w.issue_id = $1
    ORDER BY w.worked_at DESC
  `, [issue.id]);
  console.log(`user_worked_on_tickets rows (${rows.length}):`);
  for (const r of rows) console.log(`  ${r.worked_at.toISOString()}  dept=${r.dept}  reason=${r.reason}  user=${r.email}`);

  const { rows: hist } = await pool.query(`
    SELECT field, "oldValue", "newValue", "createdAt", "authorName"
    FROM issue_history WHERE "issueId" = $1 AND field IN ('department','assignee','status')
    ORDER BY "createdAt" ASC
  `, [issue.id]);
  console.log(`\nDepartment/assignee/status history (${hist.length} rows):`);
  for (const h of hist) console.log(`  ${h.createdAt.toISOString()}  [${h.field}]  ${h.authorName}: ${h.oldValue} -> ${h.newValue}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
