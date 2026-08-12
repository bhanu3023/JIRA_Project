/**
 * diagnose-worked-on.mjs
 *
 * Read-only. For each given CF-key, prints every user_worked_on_tickets row
 * (whoever is credited, in which dept, for what reason) plus the ticket's
 * dept_assignees snapshot, so we can see exactly why a specific ticket is
 * showing up in someone's "Worked on" list.
 *
 * Run: node diagnose-worked-on.mjs CF-29337 CF-29317
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

async function main() {
  const keys = process.argv.slice(2);
  if (!keys.length) { console.error('Usage: node diagnose-worked-on.mjs CF-29337 CF-29317 ...'); process.exit(1); }

  for (const cfKey of keys) {
    const issueRes = await pool.query(
      `SELECT id, key, cf_key, "assigneeId", current_department, dept_assignees FROM issues WHERE cf_key=$1 OR key=$1`,
      [cfKey]
    );
    const issue = issueRes.rows[0];
    if (!issue) { console.log(`${cfKey}: NOT FOUND`); continue; }

    const assignee = issue.assigneeId
      ? (await pool.query(`SELECT "firstName", "lastName" FROM users WHERE id=$1`, [issue.assigneeId])).rows[0]
      : null;

    const workedOnRes = await pool.query(
      `SELECT w.user_id, w.dept, w.reason, w.worked_at, u."firstName", u."lastName"
       FROM user_worked_on_tickets w LEFT JOIN users u ON u.id = w.user_id
       WHERE w.issue_id=$1 ORDER BY w.worked_at ASC`,
      [issue.id]
    );

    console.log(`\n=== ${cfKey} (${issue.key}) ===`);
    console.log(`Current assignee: ${assignee ? `${assignee.firstName} ${assignee.lastName}` : 'none'}`);
    console.log(`Current department: ${issue.current_department}`);
    console.log(`dept_assignees snapshot:`, JSON.stringify(issue.dept_assignees));
    console.log(`user_worked_on_tickets rows:`);
    for (const w of workedOnRes.rows) {
      console.log(`  - ${w.firstName || ''} ${w.lastName || ''} | dept=${w.dept} | reason=${w.reason} | worked_at=${w.worked_at}`);
    }
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
