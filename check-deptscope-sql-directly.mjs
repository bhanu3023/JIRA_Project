// Replicates deptScopeSql exactly (originDeptMatchSql OR
// updatedDeptMatchSql, the same formula used for BOTH the bare
// Queue:Dev listing and the Assignee:Pragati-filtered one -- this
// computation itself doesn't depend on whether assignees is set) and
// runs it directly against the 6 missing tickets to see if THIS part
// matches them on its own. If it does, the bug is elsewhere (param
// index drift, memberClause, or the row-fetch query diverging from
// the count query). Read-only.
//
// Usage: node check-deptscope-sql-directly.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = ['CF-33608', 'CF-33489', 'CF-33371', 'CF-33283', 'CF-33197', 'CF-30691'];

async function main() {
  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const devQueue = (cq[0]?.queues || []).find(q => q.name === 'Dev');
  const memberIds = devQueue?.memberIds || [];
  console.log(`Dev memberIds count: ${memberIds.length}`);

  // originDeptMatchSql (createdRange && queueMembersOnlyParam):
  const originSql = `(
    LOWER(COALESCE(
      i.original_dept,
      (SELECT h."oldValue" FROM issue_history h WHERE h."issueId" = i.id AND h.field = 'department' ORDER BY h."createdAt" ASC LIMIT 1),
      i.current_department
    )) = LOWER($1)
    OR EXISTS (
      SELECT 1 FROM user_worked_on_tickets w
      WHERE w.issue_id = i.id AND LOWER(w.dept) = LOWER($1) AND w.reason != 'passed' AND w.user_id = ANY($2::text[])
    )
  )`;
  // updatedDeptMatchSql (updatedRange && queueMembersOnlyParam):
  const updatedSql = `(
    (LOWER(i.current_department) = LOWER($1))
    OR (LOWER(i.current_department) != LOWER($1) AND (
      EXISTS (
        SELECT 1 FROM jsonb_each(COALESCE(i.dept_statuses, '{}'::jsonb)) ds(k, v)
        WHERE LOWER(k) = LOWER($1) AND LOWER(v->>'category') = 'done'
      )
      OR EXISTS (
        SELECT 1 FROM user_worked_on_tickets w
        WHERE w.issue_id = i.id AND LOWER(w.dept) = LOWER($1) AND w.reason != 'passed' AND w.user_id = ANY($2::text[])
      )
    ))
  )`;

  const { rows } = await pool.query(`
    SELECT COALESCE(i.cf_key, i.key) AS key,
      ${originSql} AS origin_matches,
      ${updatedSql} AS updated_matches,
      (${originSql} OR ${updatedSql}) AS deptscope_matches
    FROM issues i
    WHERE i.cf_key = ANY($3::text[]) OR i.key = ANY($3::text[])
  `, ['Dev', memberIds, KEYS]);

  for (const r of rows) {
    console.log(`${r.key}: origin_matches=${r.origin_matches} updated_matches=${r.updated_matches} deptscope_matches=${r.deptscope_matches}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
