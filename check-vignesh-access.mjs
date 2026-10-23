// Read-only: why can Vignesh T not change any option on CF-34438 (his own
// ticket)? Finds the ticket's real current_department + origin, finds
// Vignesh's user id, and replicates isUserAuthorizedForDeptQueue's exact
// logic against every queue in the space to see which queues he's actually
// a member of vs. which queue the ticket currently sits in.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const CF_KEY = 'CF-34438';

async function main() {
  const { rows: issueRows } = await pool.query(
    `SELECT i.id, i.key, i.cf_key, i.summary, i.current_department, i.original_dept, i."spaceId",
            sp.key AS space_key, i."reporterId", r."firstName" AS reporter_first, r."lastName" AS reporter_last, r.email AS reporter_email
     FROM issues i
     JOIN spaces sp ON sp.id = i."spaceId"
     LEFT JOIN users r ON r.id = i."reporterId"
     WHERE i.cf_key = $1 OR i.key = $1`,
    [CF_KEY]
  );
  if (!issueRows[0]) { console.log('Ticket not found for', CF_KEY); await pool.end(); return; }
  const issue = issueRows[0];
  console.log('--- Ticket ---');
  console.log({ key: issue.key, cf_key: issue.cf_key, current_department: issue.current_department, original_dept: issue.original_dept, reporter: `${issue.reporter_first || ''} ${issue.reporter_last || ''}`.trim(), reporter_email: issue.reporter_email, space: issue.space_key });

  const { rows: histRows } = await pool.query(
    `SELECT "oldValue", "newValue", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'department' ORDER BY "createdAt" ASC`,
    [issue.id]
  );
  console.log('\n--- Department history ---');
  histRows.forEach((h) => console.log(`${h.createdAt}: ${h.oldValue} -> ${h.newValue}`));

  const { rows: vRowsRaw } = await pool.query(
    `SELECT id, "firstName", "lastName", email, role FROM users WHERE LOWER("firstName") LIKE '%vignesh%' OR LOWER("lastName") LIKE '%vignesh%' OR LOWER(email) LIKE '%vignesh%'`
  );
  const vRows = vRowsRaw.map((v) => ({ ...v, name: `${v.firstName || ''} ${v.lastName || ''}`.trim() }));
  console.log('\n--- Matching users named Vignesh ---');
  console.log(vRows);

  const { rows: qRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [issue.space_key.toUpperCase()]);
  const queues = qRows[0]?.queues || [];
  console.log('\n--- All queues in space, with Vignesh membership ---');
  for (const v of vRows) {
    console.log(`\nFor user ${v.name} (${v.id}):`);
    for (const q of queues) {
      const memberIds = Array.isArray(q.memberIds) ? q.memberIds : [];
      const suspendedIds = Array.isArray(q.suspendedIds) ? q.suspendedIds : [];
      const isMember = memberIds.includes(v.id);
      const isSuspended = suspendedIds.includes(v.id);
      const isCurrentDept = (q.name || '').toLowerCase() === (issue.current_department || '').toLowerCase();
      console.log(`  queue "${q.name}"${isCurrentDept ? '  <-- TICKET IS CURRENTLY HERE' : ''}: member=${isMember}, suspended=${isSuspended}`);
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
