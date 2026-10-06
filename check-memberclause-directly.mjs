// deptScopeSql confirmed matching all 6 tickets on its own. memberClause
// is a SEPARATE, ADDITIONAL AND-condition pushed into deptExtraClauses
// whenever queueMembersOnlyParam is true, REGARDLESS of whether
// assignees is set -- testing its exact formula against these 6
// tickets to see if IT'S where they get excluded. Read-only.
//
// Usage: node check-memberclause-directly.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = ['CF-33608', 'CF-33489', 'CF-33371', 'CF-33283', 'CF-33197', 'CF-30691'];

async function main() {
  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const devQueue = (cq[0]?.queues || []).find(q => q.name === 'Dev');
  const memberIds = devQueue?.memberIds || [];

  // memberClause with broadenIt (createdRange || updatedRange active):
  // (assigneeId = ANY(memberIds) OR (assigneeId IS NULL AND current_dept=Dev))
  //   OR EXISTS(worked WHERE dept=Dev AND reason != 'passed' AND user_id = ANY(memberIds))
  const memberClauseSql = `(
    (i."assigneeId" = ANY($1::text[]) OR (i."assigneeId" IS NULL AND LOWER(i.current_department) = LOWER($2)))
    OR EXISTS (
      SELECT 1 FROM user_worked_on_tickets w4
      WHERE w4.issue_id = i.id AND LOWER(w4.dept) = LOWER($2) AND w4.reason != 'passed' AND w4.user_id = ANY($1::text[])
    )
  )`;

  const { rows } = await pool.query(`
    SELECT COALESCE(i.cf_key, i.key) AS key, i."assigneeId", ${memberClauseSql} AS memberclause_matches
    FROM issues i
    WHERE i.cf_key = ANY($3::text[]) OR i.key = ANY($3::text[])
  `, [memberIds, 'Dev', KEYS]);

  for (const r of rows) {
    console.log(`${r.key}: assigneeId=${r.assigneeId} memberclause_matches=${r.memberclause_matches}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
