// Read-only: redo the deptMatchSql/rosterMatchSql check but WITH the date
// clause this time (createdAt OR resolvedAt in 2026-10-01..2026-10-29,
// 'resolved' dateMode -- MBR's current default) -- the earlier check omitted
// it entirely, which may be exactly what's silently excluding these tickets
// from teamScopeRes (forcing them into the date-blind ownedOutsideRes path
// instead, with in_team_scope=false, which the breach-count summary skips).
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const devQueue = (cq[0]?.queues || []).find((q) => String(q.name || '').toLowerCase() === 'dev');
  const memberIds = devQueue?.memberIds || [];
  const { rows: memberRows } = await pool.query(`SELECT email FROM users WHERE id = ANY($1::text[]) AND email IS NOT NULL`, [memberIds]);
  const roster = memberRows.map((r) => r.email.toLowerCase());

  const deptMatchSql = `(
    i."spaceId" = (SELECT id FROM spaces WHERE key = 'TESTIN') AND (
    LOWER(i.current_department) = LOWER($1)
    OR LOWER(COALESCE(
         i.original_dept,
         (SELECT h."oldValue" FROM issue_history h WHERE h."issueId" = i.id AND h.field = 'department' ORDER BY h."createdAt" ASC LIMIT 1),
         i.current_department
       )) = LOWER($1)
    OR EXISTS (SELECT 1 FROM jsonb_each(COALESCE(i.dept_statuses, '{}'::jsonb)) ds(k, v) WHERE LOWER(k) = LOWER($1) AND LOWER(v->>'category') = 'done')
    OR EXISTS (
      SELECT 1 FROM user_worked_on_tickets w JOIN users wu ON wu.id = w.user_id
      WHERE w.issue_id = i.id AND LOWER(w.dept) = LOWER($1) AND LOWER(wu.email) = ANY($2::text[])
    )
  ))`;
  const rosterMatchSql = `(
    EXISTS (SELECT 1 FROM users rau WHERE rau.id = i."assigneeId" AND LOWER(rau.email) = ANY($2::text[]))
    OR EXISTS (
      SELECT 1 FROM user_worked_on_tickets w4 JOIN users wu4 ON wu4.id = w4.user_id
      WHERE w4.issue_id = i.id AND LOWER(w4.dept) = LOWER($1) AND LOWER(wu4.email) = ANY($2::text[])
    )
    OR (i."assigneeId" IS NULL AND LOWER(i.current_department) = LOWER($1))
    OR LOWER(i.current_department) = LOWER($1)
  )`;
  // IST-anchored date clause, createdAt OR resolvedAt (MBR's 'resolved' dateMode default)
  const dateClause = `AND (
    (i."createdAt" >= $3 AND i."createdAt" <= $4) OR (i."resolvedAt" >= $3 AND i."resolvedAt" <= $4)
  )`;
  const istFrom = new Date('2026-10-01T00:00:00+05:30');
  const istTo = new Date('2026-10-29T23:59:59.999+05:30');

  const { rows: withDate } = await pool.query(
    `SELECT COALESCE(i.cf_key, i.key) AS key
     FROM issues i
     WHERE ${deptMatchSql} AND ${rosterMatchSql} ${dateClause}
       AND COALESCE(i.cf_key, i.key) = ANY($5::text[])`,
    ['Dev', roster, istFrom, istTo, ['CF-33837', 'CF-33699', 'CF-34598', 'CF-34629']]
  );
  console.log('Tickets that pass dept+roster+DATE match (would be in teamScopeRes):', withDate.map((r) => r.key));

  const missing = ['CF-33837', 'CF-33699', 'CF-34598', 'CF-34629'].filter((k) => !withDate.some((r) => r.key === k));
  console.log('Tickets EXCLUDED once the date clause is added:', missing);

  // For the excluded ones, show their actual createdAt/resolvedAt vs the range
  if (missing.length) {
    const { rows } = await pool.query(
      `SELECT COALESCE(cf_key,key) AS key, "createdAt", "resolvedAt" FROM issues WHERE COALESCE(cf_key,key) = ANY($1::text[])`,
      [missing]
    );
    for (const r of rows) console.log(` - ${r.key}: createdAt=${r.createdAt.toISOString()} resolvedAt=${r.resolvedAt ? r.resolvedAt.toISOString() : 'null'}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
