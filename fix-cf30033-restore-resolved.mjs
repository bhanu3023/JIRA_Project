// CF-30033: restores the ticket to its resolved state from before today's
// accidental reopen-and-reroute-to-QA, and sets updatedAt/resolvedAt to
// July 25, 2026 per explicit request.
//
// Reverts:
//   - status -> Resolved (status_resolved, the same id already saved in
//     dept_statuses.Dev's own snapshot)
//   - current_department -> Dev (where it was actually resolved)
//   - assigneeId -> Akhila Aenkoju (who resolved it on Aug 4)
//   - resolvedAt, updatedAt -> 2026-07-25T12:00:00Z
//
// Also logs a history entry so this correction itself is visible in the
// ticket's own timeline, same as every other change in this app.
//
// Usage: node fix-cf30033-restore-resolved.mjs [--apply]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const NEW_DATE = new Date('2026-07-25T12:00:00Z');

async function main() {
  const { rows } = await pool.query(
    `SELECT id, "assigneeId", current_department, "statusId" FROM issues WHERE cf_key = 'CF-30033' OR key = 'CF-30033'`
  );
  const issue = rows[0];

  const { rows: akhilaRows } = await pool.query(
    `SELECT id, email FROM users WHERE "firstName" ILIKE 'Akhila%' AND "lastName" ILIKE '%Aenkoju%'`
  );
  const akhila = akhilaRows[0];
  console.log(`Akhila resolved by: ${akhila ? `${akhila.email} (${akhila.id})` : 'NOT FOUND'}`);
  if (!akhila) { console.log('Cannot proceed without resolving Akhila\'s user id.'); await pool.end(); return; }

  console.log(`Current: assigneeId=${issue.assigneeId} dept=${issue.current_department} statusId=${issue.statusId}`);
  console.log(`Will set: assigneeId=${akhila.id} dept=Dev statusId=status_resolved resolvedAt=updatedAt=${NEW_DATE.toISOString()}`);

  if (APPLY) {
    // resolvedAt and updatedAt are different underlying column types
    // (timestamptz vs naive timestamp) -- reusing one placeholder ($2) for
    // both made Postgres fail with "inconsistent types deduced for
    // parameter $2". Passing the same value as two separate placeholders
    // lets each one resolve against its own column's real type.
    await pool.query(
      `UPDATE issues
       SET "assigneeId" = $1, current_department = 'Dev', "statusId" = 'status_resolved',
           "resolvedAt" = $2, "updatedAt" = $3
       WHERE id = $4`,
      [akhila.id, NEW_DATE, NEW_DATE, issue.id]
    );
    await pool.query(
      `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt")
       VALUES ($1, $2, 'status', 'In Progress', 'Resolved', 'System', NULL, NOW())`,
      [`hist_${Date.now()}_restore`, issue.id]
    );
    console.log('Applied.');
  } else {
    console.log('Dry run only -- pass --apply to write.');
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
