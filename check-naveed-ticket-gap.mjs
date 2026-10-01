// Deeper follow-up to check-naveed-worked-count.mjs: Naveed says he worked
// 60 tickets in Aug 2026, the app shows 44 (Queue:Dev, real work only).
// Raw data already shows why 44 != 60 at the reason-code level (19 of his
// 70 raw rows are reason='passed', routing-only, deliberately excluded from
// "worked" credit everywhere in this app -- see the standing comment on
// workedByMemberSql). This script goes further: checks every ticket
// CURRENTLY assigned to him, and every ticket he authored a real status
// change on in Aug, for whether a user_worked_on_tickets credit row exists
// at all -- to catch a genuine missing-credit gap, not just a reason-code
// category he doesn't like.
//
// Read-only.
//
// Usage: node check-naveed-ticket-gap.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const EMAIL = 'naved.osama@cloudfuze.com';

async function main() {
  const { rows: userRows } = await pool.query(`SELECT id, "firstName", "lastName", email FROM users WHERE email = $1`, [EMAIL]);
  const user = userRows[0];
  console.log(`User: ${user.firstName} ${user.lastName} <${user.email}>  id=${user.id}\n`);

  const { rows: creditedIssues } = await pool.query(
    `SELECT DISTINCT issue_id FROM user_worked_on_tickets
     WHERE user_id = $1 AND worked_at >= '2026-08-01' AND worked_at < '2026-09-01'`,
    [user.id]
  );
  const creditedSet = new Set(creditedIssues.map(r => r.issue_id));
  console.log(`Distinct issues with ANY worked-on credit row in Aug (any reason): ${creditedSet.size}\n`);

  console.log('=== Tickets CURRENTLY assigned to him ===');
  const { rows: assigned } = await pool.query(
    `SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i.current_department, s.name AS status_name,
            i."createdAt", i."updatedAt"
     FROM issues i LEFT JOIN statuses s ON i."statusId" = s.id
     WHERE i."assigneeId" = $1`,
    [user.id]
  );
  console.log(`Total tickets currently assigned to him (any date): ${assigned.length}`);
  const assignedNoCreditAug = assigned.filter(r => !creditedSet.has(r.id));
  console.log(`...of those, with NO Aug worked-on credit row at all: ${assignedNoCreditAug.length}`);
  for (const r of assignedNoCreditAug.slice(0, 30)) {
    console.log(`    ${r.key}  dept=${r.current_department}  status=${r.status_name}  created=${r.createdAt.toISOString().slice(0,10)}  updated=${r.updatedAt.toISOString().slice(0,10)}`);
  }
  if (assignedNoCreditAug.length > 30) console.log(`    ...and ${assignedNoCreditAug.length - 30} more`);

  console.log('\n=== Tickets he authored a real status change on in Aug 2026 ===');
  const { rows: statusChanges } = await pool.query(
    `SELECT DISTINCT h."issueId", COALESCE(i.cf_key, i.key) AS key, i.current_department
     FROM issue_history h
     JOIN issues i ON i.id = h."issueId"
     WHERE h.field = 'status' AND h."authorEmail" = $1
       AND h."createdAt" >= '2026-08-01' AND h."createdAt" < '2026-09-01'`,
    [EMAIL]
  );
  console.log(`Distinct tickets he changed the status of in Aug: ${statusChanges.length}`);
  const touchedNoCreditAug = statusChanges.filter(r => !creditedSet.has(r.issueId));
  console.log(`...of those, with NO Aug worked-on credit row at all: ${touchedNoCreditAug.length}`);
  for (const r of touchedNoCreditAug.slice(0, 30)) {
    console.log(`    ${r.key}  dept=${r.current_department}`);
  }
  if (touchedNoCreditAug.length > 30) console.log(`    ...and ${touchedNoCreditAug.length - 30} more`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
