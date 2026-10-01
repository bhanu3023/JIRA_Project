// Detail dump for the 6 tickets check-naveed-ticket-gap.mjs found: Naveed
// authored a real status change on each in Aug 2026, but none has a
// user_worked_on_tickets credit row for him at all. Pulls full status +
// assignee history around his change, plus the ticket's current state, to
// see whether a specific known guard (e.g. reassigningToSomeoneElse
// suppressing 'worked' credit right after a handoff) explains it, or
// whether this is a genuine capture gap.
//
// Read-only.
//
// Usage: node check-naveed-migration-gap-detail.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = ['CF-29690', 'CF-29843', 'CF-29540', 'CF-29409', 'CF-29891', 'CF-29808'];

async function main() {
  for (const key of KEYS) {
    const { rows } = await pool.query(
      `SELECT i.id, i.current_department, i."assigneeId", au.email AS assignee_email, i.dept_assignees
       FROM issues i LEFT JOIN users au ON au.id = i."assigneeId"
       WHERE i.cf_key = $1 OR i.key = $1`,
      [key]
    );
    if (!rows.length) { console.log(`${key}: NOT FOUND`); continue; }
    const issue = rows[0];
    console.log(`\n${key}  current_department=${issue.current_department}  live_assignee=${issue.assignee_email}`);
    console.log(`  dept_assignees=${JSON.stringify(issue.dept_assignees)}`);

    const { rows: hist } = await pool.query(
      `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt"
       FROM issue_history
       WHERE "issueId" = $1 AND field IN ('status','assignee','department')
       ORDER BY "createdAt" ASC`,
      [issue.id]
    );
    for (const h of hist) {
      console.log(`    [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}"  (by ${h.authorName} <${h.authorEmail}>)`);
    }

    const { rows: worked } = await pool.query(
      `SELECT wu.email, w.dept, w.reason, w.worked_at FROM user_worked_on_tickets w
       JOIN users wu ON wu.id = w.user_id WHERE w.issue_id = $1 ORDER BY w.worked_at ASC`,
      [issue.id]
    );
    console.log(`  ALL worked-on rows for this ticket (any user, any date):`);
    for (const w of worked) console.log(`    ${w.email}  dept=${w.dept}  reason=${w.reason}  at=${w.worked_at.toISOString()}`);
    if (!worked.length) console.log('    (none at all)');
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
