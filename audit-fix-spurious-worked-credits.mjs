// Cleans up historical user_worked_on_tickets rows with reason='worked'
// that predate the fix already in jira-pg-api.ts's PATCH handler (see the
// "reassigningToSomeoneElse" comment there): a person who only reassigned a
// ticket to someone ELSE (routing, not working it) sometimes got wrongly
// credited with 'worked' before that guard existed. Confirmed for real on
// CF-29950: Shiva Amuda credited 'worked' in Dev at 2026-08-31T08:35:28Z,
// one second after her only action on the ticket -- reassigning it from
// unassigned to Shivam Singh (issue_history: assignee null -> "Shivam
// Singh", authorName "Shiva Amuda") -- with no status change in that same
// moment. The person who actually worked it (Shivam Singh) changed the
// status himself 77 seconds later and is correctly credited separately.
//
// A 'worked' row is PROVEN spurious by this same pattern when there's an
// issue_history 'assignee' row within 5 seconds of worked_at, authored by
// this same user, whose newValue is a DIFFERENT person (not this user) --
// i.e. they were routing the ticket away, not doing the work. Only rows
// matching this exact evidence get removed; anything else (including
// legitimate self-assignments, or 'worked' rows with no matching
// assignee-history row at all) is left untouched.
//
// Usage:
//   node audit-fix-spurious-worked-credits.mjs           # dry run, full report
//   node audit-fix-spurious-worked-credits.mjs --apply   # deletes the PROVEN spurious rows

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log("Scanning reason='worked' rows for the routing-not-working pattern...");
  const { rows: workedRows } = await pool.query(`
    SELECT w.user_id, w.issue_id, w.dept, w.worked_at, wu."firstName", wu."lastName", wu.email,
           COALESCE(i.cf_key, i.key) AS key
    FROM user_worked_on_tickets w
    JOIN users wu ON wu.id = w.user_id
    JOIN issues i ON i.id = w.issue_id
    WHERE w.reason = 'worked'
  `);
  console.log(`${workedRows.length} 'worked'-reason row(s) to check.\n`);

  const spurious = [];
  let checked = 0;
  for (const row of workedRows) {
    checked++;
    const { rows: assigneeHist } = await pool.query(
      `SELECT "newValue", "authorName", "createdAt" FROM issue_history
       WHERE "issueId" = $1 AND field = 'assignee'
         AND "authorName" = TRIM(CONCAT($2::text, ' ', $3::text))
         AND "createdAt" BETWEEN $4::timestamptz - interval '5 seconds' AND $4::timestamptz + interval '5 seconds'
       ORDER BY "createdAt" ASC LIMIT 1`,
      [row.issue_id, row.firstName, row.lastName, row.worked_at]
    );
    if (!assigneeHist.length) continue;
    const actorFullName = `${row.firstName} ${row.lastName}`.trim();
    const assignedTo = assigneeHist[0].newValue;
    if (assignedTo && assignedTo !== actorFullName && assignedTo !== 'null') {
      // Also require NO status-history row by this same actor at the same
      // moment, matching the live guard's full condition -- otherwise this
      // really was a legitimate "assigned + changed status" action.
      const { rows: statusHist } = await pool.query(
        `SELECT 1 FROM issue_history WHERE "issueId" = $1 AND field = 'status' AND "authorName" = $2
         AND "createdAt" BETWEEN $3::timestamptz - interval '5 seconds' AND $3::timestamptz + interval '5 seconds' LIMIT 1`,
        [row.issue_id, actorFullName, row.worked_at]
      );
      if (!statusHist.length) {
        spurious.push({ ...row, assignedTo, actorFullName });
      }
    }
  }

  console.log(`Checked ${checked}. Found ${spurious.length} PROVEN spurious credit(s) (routed to someone else, no simultaneous status change):\n`);
  for (const s of spurious.slice(0, 30)) {
    console.log(`  ${s.key}  ${s.actorFullName} <${s.email}>  dept=${s.dept}  worked_at=${s.worked_at.toISOString()}  -- routed to "${s.assignedTo}", never touched it themselves`);
  }
  if (spurious.length > 30) console.log(`  ...and ${spurious.length - 30} more`);

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to delete these ${spurious.length} spurious credit(s).`);
    await pool.end();
    return;
  }

  let deleted = 0;
  for (const s of spurious) {
    await pool.query(
      `DELETE FROM user_worked_on_tickets WHERE user_id = $1 AND issue_id = $2 AND dept = $3 AND reason = 'worked'`,
      [s.user_id, s.issue_id, s.dept]
    );
    deleted++;
  }
  console.log(`\nDeleted ${deleted} spurious 'worked' credit(s).`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
