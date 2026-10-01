// Audits every ticket where one of a named set of people is assignee OR
// reporter, checking three things that have each been real, confirmed bugs
// elsewhere in this project:
//   1. status/resolvedAt consistency (the Sept-14 bulk-reimport corruption
//      pattern: status says done but resolvedAt is null, or vice versa)
//   2. dept_assignees snapshot staleness vs the live assigneeId (the same
//      drift class already audited/fixed for 732 other tickets this session)
//   3. orphaned assignee/reporter ids that don't resolve to a real user
//
// Read-only -- prints findings, changes nothing.
//
// Usage: node audit-check-people-tickets.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const NAMES = ['Lakshmi', 'Lakshma', 'Ganesh', 'Chaitanya', 'David', 'Harshith'];

async function main() {
  const { rows: people } = await pool.query(
    `SELECT id, "firstName", "lastName", email FROM users WHERE ${NAMES.map((_, i) => `"firstName" ILIKE $${i + 1}`).join(' OR ')}`,
    NAMES.map(n => `%${n}%`)
  );
  if (!people.length) {
    console.log('No matching users found for:', NAMES.join(', '));
    await pool.end();
    return;
  }
  console.log(`Matched ${people.length} user(s):`);
  for (const p of people) console.log(`  ${p.id}  ${p.firstName} ${p.lastName}  <${p.email}>`);
  const ids = people.map(p => p.id);

  const { rows: issues } = await pool.query(
    `SELECT i.id, i.key, i.cf_key, i.summary, i."assigneeId", i."reporterId", i."resolvedAt",
            i.current_department, i.dept_assignees, s.name AS status_name, s.category AS status_category
     FROM issues i
     LEFT JOIN statuses s ON s.id = i."statusId"
     WHERE i."assigneeId" = ANY($1) OR i."reporterId" = ANY($1)
     ORDER BY i."createdAt" DESC`,
    [ids]
  );
  console.log(`\n${issues.length} ticket(s) where one of these people is assignee or reporter.\n`);

  const byId = Object.fromEntries(people.map(p => [p.id, `${p.firstName} ${p.lastName}`]));

  const resolvedAtMismatches = [];
  const orphanedRefs = [];
  const staleAssignees = [];

  for (const row of issues) {
    const key = row.cf_key || row.key;

    // 1. status/resolvedAt consistency
    const isDone = row.status_category === 'done';
    if (isDone && !row.resolvedAt) resolvedAtMismatches.push(`${key}  status="${row.status_name}" but resolvedAt=NULL`);
    if (!isDone && row.resolvedAt) resolvedAtMismatches.push(`${key}  status="${row.status_name}" (not done) but resolvedAt=${row.resolvedAt.toISOString()}`);

    // 2. orphaned assignee/reporter
    if (row.assigneeId && !byId[row.assigneeId]) {
      const { rows: u } = await pool.query(`SELECT 1 FROM users WHERE id=$1`, [row.assigneeId]);
      if (!u.length) orphanedRefs.push(`${key}  assigneeId ${row.assigneeId} does not resolve to any user`);
    }
    if (row.reporterId && !byId[row.reporterId]) {
      const { rows: u } = await pool.query(`SELECT 1 FROM users WHERE id=$1`, [row.reporterId]);
      if (!u.length) orphanedRefs.push(`${key}  reporterId ${row.reporterId} does not resolve to any user`);
    }

    // 3. dept_assignees staleness vs live assigneeId, for the current department.
    // Snapshot values are objects ({id, displayName, ...}), not plain ids --
    // comparing the object to a string id directly (as an earlier version of
    // this script did) always mismatches, which is a false positive, not a
    // real finding.
    if (row.current_department && row.dept_assignees) {
      const deptMap = typeof row.dept_assignees === 'string' ? JSON.parse(row.dept_assignees) : row.dept_assignees;
      const key2 = Object.keys(deptMap || {}).find(k => k.toLowerCase() === row.current_department.trim().toLowerCase());
      const snapshot = key2 ? deptMap[key2] : undefined;
      const snapId = snapshot?.id;
      if (snapId && snapId !== row.assigneeId) {
        const snapName = byId[snapId] || snapshot.displayName || snapId;
        const liveName = byId[row.assigneeId] || row.assigneeId || '(unassigned)';
        staleAssignees.push(`${key}  dept_assignees["${row.current_department}"]=${snapName}  but live assignee=${liveName}`);
      }
    }
  }

  console.log(`\n=== status="done" but resolvedAt is NULL (or vice versa): ${resolvedAtMismatches.length} ===`);
  for (const l of resolvedAtMismatches.slice(0, 25)) console.log('  ' + l);
  if (resolvedAtMismatches.length > 25) console.log(`  ...and ${resolvedAtMismatches.length - 25} more`);

  console.log(`\n=== orphaned assignee/reporter references: ${orphanedRefs.length} ===`);
  for (const l of orphanedRefs.slice(0, 25)) console.log('  ' + l);
  if (orphanedRefs.length > 25) console.log(`  ...and ${orphanedRefs.length - 25} more`);

  console.log(`\n=== dept_assignees snapshot genuinely stale vs live assignee: ${staleAssignees.length} ===`);
  for (const l of staleAssignees.slice(0, 25)) console.log('  ' + l);
  if (staleAssignees.length > 25) console.log(`  ...and ${staleAssignees.length - 25} more`);

  console.log(`\nTotal tickets checked: ${issues.length}`);
  await pool.end();
}

main().catch(async (e) => {
  console.error('Unexpected error:', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
