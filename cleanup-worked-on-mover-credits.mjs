/**
 * cleanup-worked-on-mover-credits.mjs
 *
 * Department transfers used to credit BOTH the ticket's real assignee AND
 * whoever performed the transfer with a `user_worked_on_tickets` 'passed'
 * row -- meant only as a fallback for a ticket with no assignee at all, but
 * written unconditionally. Anyone who ever moved a department on a ticket
 * that already had a real assignee (very often an admin doing routine queue
 * management) got that ticket added to their own personal "Worked on" list,
 * next to tickets they had nothing to do with.
 *
 * This removes exactly those leftover rows: a 'passed' row for a user is
 * deleted only when dept_assignees[dept] for that ticket names a DIFFERENT,
 * real person -- i.e. there was a real assignee on record for that dept
 * visit, so this row could only be the buggy mover-fallback credit, never
 * the legitimate "no assignee, fall back to the mover" case. A row is left
 * alone whenever dept_assignees[dept] is empty/unset (can't tell, could be
 * the intended fallback) or already matches the row's own user_id.
 *
 * Never touches ticket status, assignee, comments, or anything else --
 * only ever deletes rows from user_worked_on_tickets.
 *
 * Env vars:
 *   DATABASE_URL - optional, defaults to the local dev DB
 *   DRY_RUN      - default 'true'; pass 'false' to actually delete
 *
 * Run: node cleanup-worked-on-mover-credits.mjs
 * Apply for real: DRY_RUN=false node cleanup-worked-on-mover-credits.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const DRY_RUN = process.env.DRY_RUN !== 'false';

async function main() {
  const rows = await pool.query(`
    SELECT w.user_id, w.issue_id, w.dept, i.key, i.dept_assignees,
           u."firstName", u."lastName", u.email
    FROM user_worked_on_tickets w
    JOIN issues i ON i.id = w.issue_id
    LEFT JOIN users u ON u.id = w.user_id
    WHERE w.reason = 'passed'
  `);
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Checking ${rows.rows.length} 'passed' worked-on rows.`);

  let toDelete = 0;
  let kept = 0;
  const sample = [];
  const byUser = {};

  for (const r of rows.rows) {
    const deptAssignees = r.dept_assignees || {};
    const realAssignee = deptAssignees[r.dept];
    const mismatch = realAssignee?.id && realAssignee.id !== r.user_id;
    if (!mismatch) { kept++; continue; }

    toDelete++;
    const who = `${r.firstName || ''} ${r.lastName || ''}`.trim() || r.email || r.user_id;
    byUser[who] = (byUser[who] || 0) + 1;
    if (sample.length < 20) {
      sample.push({ key: r.key, dept: r.dept, wronglyCreditedTo: who, realAssignee: realAssignee?.displayName || realAssignee?.firstName });
    }
    if (!DRY_RUN) {
      await pool.query(
        `DELETE FROM user_worked_on_tickets WHERE user_id=$1 AND issue_id=$2 AND dept=$3 AND reason='passed'`,
        [r.user_id, r.issue_id, r.dept]
      );
    }
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Done.`);
  console.log({ checked: rows.rows.length, toDelete, kept });
  console.log('\nBy user (how many spurious credits each had):');
  console.log(byUser);
  console.log('\nSample (up to 20):');
  console.log(sample);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
