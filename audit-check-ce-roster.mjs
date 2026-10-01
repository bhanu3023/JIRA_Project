// Same audit as audit-check-people-tickets.mjs, scoped to the exact
// Customer Engineering (TEAM_ROSTER.eng) roster from jira-pg-api.ts, to
// check whether MBR's CE numbers could be off for the same reasons already
// found and partly fixed today (missing resolvedAt, stale dept_assignees
// snapshots) -- rather than guessing at what "not accurate" means.
//
// Read-only.
//
// Usage: node audit-check-ce-roster.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const CE_ROSTER = [
  'abhinandan.kumar@cloudfuze.com', 'akhila.aenkoju@cloudfuze.com', 'akib.mohd@cloudfuze.com', 'ankit@cloudfuze.com',
  'bhagyashri.deokar@cloudfuze.com', 'hemadasu.kantam@cloudfuze.com', 'jaswanth.adari@cloudfuze.com', 'lakshmi.adabala@cloudfuze.com',
  'mayank@cloudfuze.com', 'naved.osama@cloudfuze.com', 'pragati.pandey@cloudfuze.com', 'ravi.srivastava@cloudfuze.com',
  'rehan.khan@cloudfuze.com', 'sairaj.kanigicharla@cloudfuze.com', 'shiva.amuda@cloudfuze.com', 'shivam.singh@cloudfuze.com',
  'srinu.gudimitla@cloudfuze.com', 'vamsi.malla@cloudfuze.com', 'vishal.kumar@cloudfuze.com',
];

async function main() {
  const { rows: people } = await pool.query(
    `SELECT id, "firstName", "lastName", email FROM users WHERE LOWER(email) = ANY($1::text[])`,
    [CE_ROSTER]
  );
  console.log(`Matched ${people.length} of ${CE_ROSTER.length} CE roster user(s).`);
  const missing = CE_ROSTER.filter(e => !people.some(p => p.email.toLowerCase() === e));
  if (missing.length) console.log(`No user account found for: ${missing.join(', ')}`);
  const ids = people.map(p => p.id);
  const byId = Object.fromEntries(people.map(p => [p.id, `${p.firstName} ${p.lastName}`]));

  const { rows: issues } = await pool.query(`
    SELECT i.id, i.cf_key, i.key, i."assigneeId", i."reporterId", i."resolvedAt",
           i.current_department, i.dept_assignees, s.name AS status_name, s.category AS status_category
    FROM issues i
    LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE i."assigneeId" = ANY($1) OR i."reporterId" = ANY($1)
  `, [ids]);
  console.log(`${issues.length} ticket(s) where a CE roster member is assignee or reporter.\n`);

  const resolvedAtMismatches = [];
  const staleAssignees = [];

  for (const row of issues) {
    const key = row.cf_key || row.key;
    const isDone = row.status_category === 'done';
    if (isDone && !row.resolvedAt) resolvedAtMismatches.push(`${key}  status="${row.status_name}" but resolvedAt=NULL`);
    if (!isDone && row.resolvedAt) resolvedAtMismatches.push(`${key}  status="${row.status_name}" (not done) but resolvedAt=${row.resolvedAt.toISOString()}`);

    if (row.current_department && row.dept_assignees) {
      const deptMap = typeof row.dept_assignees === 'string' ? JSON.parse(row.dept_assignees) : row.dept_assignees;
      const k = Object.keys(deptMap || {}).find(x => x.toLowerCase() === row.current_department.trim().toLowerCase());
      const snapshot = k ? deptMap[k] : undefined;
      const snapId = snapshot?.id;
      if (snapId && snapId !== row.assigneeId) {
        const snapName = byId[snapId] || snapshot.displayName || snapId;
        const liveName = byId[row.assigneeId] || row.assigneeId || '(unassigned)';
        staleAssignees.push(`${key}  dept_assignees["${row.current_department}"]=${snapName}  but live assignee=${liveName}`);
      }
    }
  }

  console.log(`=== status/resolvedAt mismatches: ${resolvedAtMismatches.length} ===`);
  for (const l of resolvedAtMismatches.slice(0, 15)) console.log('  ' + l);
  if (resolvedAtMismatches.length > 15) console.log(`  ...and ${resolvedAtMismatches.length - 15} more`);

  console.log(`\n=== stale dept_assignees snapshots: ${staleAssignees.length} ===`);
  for (const l of staleAssignees.slice(0, 15)) console.log('  ' + l);
  if (staleAssignees.length > 15) console.log(`  ...and ${staleAssignees.length - 15} more`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
