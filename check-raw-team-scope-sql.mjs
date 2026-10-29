// Read-only: run the REAL deptMatchSql/rosterMatchSql predicates (copied
// verbatim from reports/mbr-team's own eng/qa/infra branch) against the live
// Dev roster, directly against these 4 specific tickets, instead of
// reasoning about it secondhand.
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

  const { rows } = await pool.query(
    `SELECT COALESCE(i.cf_key, i.key) AS key,
            ${deptMatchSql} AS dept_match,
            ${rosterMatchSql} AS roster_match
     FROM issues i
     WHERE COALESCE(i.cf_key, i.key) = ANY($3::text[])`,
    ['Dev', roster, ['CF-33837', 'CF-33699', 'CF-34598', 'CF-34629']]
  );
  for (const r of rows) console.log(`${r.key}: dept_match=${r.dept_match}, roster_match=${r.roster_match} -> in_team_scope=${r.dept_match && r.roster_match}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
