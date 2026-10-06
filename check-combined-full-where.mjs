// Combines deptScopeSql AND memberClause AND the Created/Updated date
// range filters into ONE query, exactly as the real dept-scoped branch
// would for Queue:Dev (no assignee) + Created/Updated Sep 2026 --
// both pieces individually confirmed matching the 6 missing tickets,
// so this checks whether COMBINING them (plus the date filters I
// hadn't included in the isolated tests) still matches, to find the
// true SQL-level total. Read-only.
//
// Usage: node check-combined-full-where.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = ['CF-33608', 'CF-33489', 'CF-33371', 'CF-33283', 'CF-33197', 'CF-30691'];

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = 'TESTIN'`);
  const spaceId = spaceRows[0].id;
  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const devQueue = (cq[0]?.queues || []).find(q => q.name === 'Dev');
  const memberIds = devQueue?.memberIds || [];

  const deptScopeSql = `(
    (
      LOWER(COALESCE(
        i.original_dept,
        (SELECT h."oldValue" FROM issue_history h WHERE h."issueId" = i.id AND h.field = 'department' ORDER BY h."createdAt" ASC LIMIT 1),
        i.current_department
      )) = LOWER($1)
      OR EXISTS (
        SELECT 1 FROM user_worked_on_tickets w
        WHERE w.issue_id = i.id AND LOWER(w.dept) = LOWER($1) AND w.reason != 'passed' AND w.user_id = ANY($2::text[])
      )
    )
    OR (
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
    )
  )`;
  const memberClauseSql = `(
    (i."assigneeId" = ANY($2::text[]) OR (i."assigneeId" IS NULL AND LOWER(i.current_department) = LOWER($1)))
    OR EXISTS (
      SELECT 1 FROM user_worked_on_tickets w4
      WHERE w4.issue_id = i.id AND LOWER(w4.dept) = LOWER($1) AND w4.reason != 'passed' AND w4.user_id = ANY($2::text[])
    )
  )`;

  const { rows: countRows } = await pool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM issues i
    WHERE i."spaceId" = $3
      AND ${deptScopeSql}
      AND ${memberClauseSql}
      AND i."createdAt" >= '2026-09-01' AND i."createdAt" < '2026-10-01'
      AND i."updatedAt" >= '2026-09-01' AND i."updatedAt" < '2026-10-01'
  `, ['Dev', memberIds, spaceId]);
  console.log(`Combined deptScope + memberClause + date-range total: ${countRows[0].cnt} (API reported 581)`);

  const { rows: sixRows } = await pool.query(`
    SELECT COALESCE(i.cf_key, i.key) AS key
    FROM issues i
    WHERE i."spaceId" = $3
      AND ${deptScopeSql}
      AND ${memberClauseSql}
      AND i."createdAt" >= '2026-09-01' AND i."createdAt" < '2026-10-01'
      AND i."updatedAt" >= '2026-09-01' AND i."updatedAt" < '2026-10-01'
      AND (i.cf_key = ANY($4::text[]) OR i.key = ANY($4::text[]))
  `, ['Dev', memberIds, spaceId, KEYS]);
  console.log(`Of the 6 missing tickets, how many match this full combined WHERE: ${sixRows.length}`);
  console.log(sixRows.map(r => r.key));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
