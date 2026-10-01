// Distinguishing two different, unrelated reasons a Migration-department
// ticket could legitimately match "Queue: Dev": (a) it ORIGINATED in Dev
// (original_dept='Dev' or its first department-history row says so) --
// this path has NO member restriction by design, matching is based on
// where the ticket came from, not who worked it; vs (b) a worked-on
// record with dept='Dev' from someone who ISN'T a configured Dev queue
// member -- which SHOULD be impossible if the member-restriction guard
// (deptMemberIdsParamIdx) is being correctly applied, since that's exactly
// what it exists to prevent.
//
// Read-only.
//
// Usage: node check-dev-origin-vs-worker-bug.mjs
import pg from 'pg';

const DEV_QUEUE_MEMBER_NAMES = [
  'srinu gudimitla', 'Akib Mohd', 'Shivam Singh', 'Shiva Amuda', 'Prakash Singampalli',
  'Bhagyashri Deokar', 'K N V S Raj Kumar', 'Pragati Pandey', 'Naved', 'Akhila Aenkoju',
  'Giridhar K', 'Suraj kumar', 'Adari Venkata Jaswanth', 'Praveen Kothagolla', 'Mayank Jain',
  'Praveen v', 'Soubhagya Behera', 'Vishal Kumar', 'Ravi Srivastava', 'Ankit Mishra',
  'Rehan Khan', 'Jyoshitha Dhannapaneni', 'Ravi  Hemanth', 'Hemadasu Kantam', 'Abhinav Surattu',
  'vamsi malla', 'Anush Dasari', 'Abhinandan Kumar', 'Bharath T', 'Lakshmi Adabala',
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: devMembers } = await pool.query(
    `SELECT id, "firstName" || ' ' || "lastName" AS name FROM users
     WHERE TRIM("firstName" || ' ' || "lastName") = ANY($1::text[])`,
    [DEV_QUEUE_MEMBER_NAMES]
  );
  const devMemberIds = new Set(devMembers.map((u) => u.id));
  console.log(`Resolved ${devMemberIds.size} of ${DEV_QUEUE_MEMBER_NAMES.length} Dev queue member names to real user IDs`);

  // The 140 Migration-department tickets in the matched window
  const { rows: tickets } = await pool.query(
    `SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i.original_dept,
            (SELECT h."oldValue" FROM issue_history h WHERE h."issueId" = i.id AND h.field = 'department' ORDER BY h."createdAt" ASC LIMIT 1) AS first_dept_history
     FROM issues i JOIN spaces sp ON sp.id = i."spaceId"
     WHERE sp.key = 'TESTIN' AND i.current_department = 'Migration'
       AND (i."createdAt" >= '2026-09-14' AND i."createdAt" < '2026-09-21'
         OR i."updatedAt" >= '2026-09-14' AND i."updatedAt" < '2026-09-21')`
  );

  let originatedInDev = 0, notOriginatedInDev = 0;
  const notOriginatedKeys = [];
  for (const t of tickets) {
    const origin = t.original_dept || t.first_dept_history;
    if (origin && origin.toLowerCase() === 'dev') originatedInDev++;
    else { notOriginatedInDev++; notOriginatedKeys.push(t.key); }
  }
  console.log(`\nOf ${tickets.length} Migration-department tickets in the matched set:`);
  console.log(`  originated in Dev (legit, no member-restriction needed): ${originatedInDev}`);
  console.log(`  did NOT originate in Dev: ${notOriginatedInDev}`);

  if (notOriginatedKeys.length) {
    // For the ones that did NOT originate in Dev, they must be matching via
    // the worked-on-record path -- check whether the worker is a real Dev
    // queue member or not, for a sample
    const { rows: sample } = await pool.query(
      `SELECT COALESCE(i.cf_key, i.key) AS key, w.user_id, w.reason, u."firstName", u."lastName"
       FROM issues i
       JOIN user_worked_on_tickets w ON w.issue_id = i.id AND LOWER(w.dept) = 'dev' AND w.reason != 'passed'
       LEFT JOIN users u ON u.id = w.user_id
       WHERE COALESCE(i.cf_key, i.key) = ANY($1::text[])
       LIMIT 20`,
      [notOriginatedKeys]
    );
    let nonMemberMatches = 0;
    console.log(`\nSample of non-origin-in-Dev tickets and who logged their dept='Dev' worked-on record:`);
    for (const r of sample) {
      const isMember = devMemberIds.has(r.user_id);
      if (!isMember) nonMemberMatches++;
      console.log(`  ${r.key}: ${r.firstName} ${r.lastName} (reason=${r.reason}) -- ${isMember ? 'IS a Dev queue member' : 'NOT a Dev queue member'}`);
    }
    console.log(`\n${nonMemberMatches} of ${sample.length} sampled are matching via a NON-Dev-queue-member's worked-on record -- if > 0, the member-restriction guard is not being applied.`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
