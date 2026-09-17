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
    `SELECT i.id, i.key, i."cfKey", i.summary, i."assigneeId", i."reporterId", i."resolvedAt",
            i.current_department, i.dept_assignees, s.name AS status_name, s.category AS status_category
     FROM issues i
     LEFT JOIN statuses s ON s.id = i."statusId"
     WHERE i."assigneeId" = ANY($1) OR i."reporterId" = ANY($1)
     ORDER BY i."createdAt" DESC`,
    [ids]
  );
  console.log(`\n${issues.length} ticket(s) where one of these people is assignee or reporter.\n`);

  const byId = Object.fromEntries(people.map(p => [p.id, `${p.firstName} ${p.lastName}`]));
  let flagCount = 0;

  for (const row of issues) {
    const flags = [];
    const key = row.cfKey || row.key;

    // 1. status/resolvedAt consistency
    const isDone = row.status_category === 'done';
    if (isDone && !row.resolvedAt) flags.push(`status is "${row.status_name}" (done) but resolvedAt is NULL`);
    if (!isDone && row.resolvedAt) flags.push(`status is "${row.status_name}" (not done) but resolvedAt is SET (${row.resolvedAt.toISOString()})`);

    // 2. orphaned assignee/reporter
    if (row.assigneeId && !byId[row.assigneeId] ) {
      const { rows: u } = await pool.query(`SELECT "firstName","lastName" FROM users WHERE id=$1`, [row.assigneeId]);
      if (!u.length) flags.push(`assigneeId ${row.assigneeId} does not resolve to any user`);
    }
    if (row.reporterId && !byId[row.reporterId]) {
      const { rows: u } = await pool.query(`SELECT "firstName","lastName" FROM users WHERE id=$1`, [row.reporterId]);
      if (!u.length) flags.push(`reporterId ${row.reporterId} does not resolve to any user`);
    }

    // 3. dept_assignees staleness vs live assigneeId, for the current department
    if (row.current_department && row.dept_assignees) {
      try {
        const deptMap = typeof row.dept_assignees === 'string' ? JSON.parse(row.dept_assignees) : row.dept_assignees;
        const snapshot = deptMap?.[row.current_department];
        if (snapshot && snapshot !== row.assigneeId) {
          const snapName = byId[snapshot] || snapshot;
          const liveName = byId[row.assigneeId] || row.assigneeId || '(unassigned)';
          flags.push(`dept_assignees snapshot for "${row.current_department}" says ${snapName}, but live assignee is ${liveName}`);
        }
      } catch { /* malformed JSON, not this audit's concern */ }
    }

    if (flags.length) {
      flagCount++;
      console.log(`[${key}] ${row.summary}`);
      console.log(`  assignee=${byId[row.assigneeId] || row.assigneeId || '(none)'}  reporter=${byId[row.reporterId] || row.reporterId || '(none)'}  status=${row.status_name}`);
      for (const f of flags) console.log(`  ⚠ ${f}`);
      console.log('');
    }
  }

  console.log(`\nDone. ${flagCount} of ${issues.length} ticket(s) flagged.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error('Unexpected error:', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
