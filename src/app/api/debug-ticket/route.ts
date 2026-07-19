import { NextRequest } from 'next/server';
import { Pool } from 'pg';

const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:neutara123@localhost:5433/neutara_db',
});

export async function GET(req: NextRequest) {
  const dept = req.nextUrl.searchParams.get('dept') || 'Migration';
  const spaceKey = req.nextUrl.searchParams.get('spaceKey') || 'TESTIN';

  try {
    const spaceRow = await dbPool.query(`SELECT id FROM spaces WHERE UPPER(key) = UPPER($1)`, [spaceKey]);
    const spaceId = spaceRow.rows[0]?.id ?? null;
    if (!spaceId) return Response.json({ ok: false, error: `Space ${spaceKey} not found` });

    const allSpaceIds = [spaceId];

    const sentExistsClause = `(
      EXISTS (
        SELECT 1 FROM queue_closed_tickets qct
        WHERE qct.issue_id = i.id
          AND LOWER(qct.dept_name) = LOWER($2)
          AND i."spaceId" = ANY($1::text[])
      )
      OR EXISTS (
        SELECT 1 FROM issue_dept_transitions t
        WHERE t.issue_id = i.id
          AND LOWER(t.from_dept) = LOWER($2)
          AND LOWER(t.to_dept) != LOWER($2)
      )
      OR (
        i.dept_statuses IS NOT NULL
        AND (
          jsonb_exists(i.dept_statuses, $2)
          OR jsonb_exists(i.dept_statuses, LOWER($2))
          OR jsonb_exists(i.dept_statuses, INITCAP(LOWER($2)))
        )
        AND LOWER(COALESCE(i.current_department,'')) != LOWER($2)
      )
      OR (
        LOWER(COALESCE(i.original_dept,'')) = LOWER($2)
        AND LOWER(COALESCE(i.current_department,'')) != LOWER($2)
      )
    )`;

    // Run exact count query
    let countResult = null, countError = null;
    try {
      const cr = await dbPool.query(
        `SELECT COUNT(DISTINCT i.id)::int AS cnt FROM issues i
         WHERE i."spaceId" = ANY($1::text[])
           AND LOWER(COALESCE(i.current_department, '')) != LOWER($2)
           AND ${sentExistsClause}`,
        [allSpaceIds, dept]
      );
      countResult = cr.rows[0]?.cnt;
    } catch(e: any) { countError = e?.message; }

    // Run exact rows query
    let rowsResult = null, rowsError = null;
    try {
      const rr = await dbPool.query(
        `SELECT DISTINCT ON (i.id) i.key, i.current_department, i.original_dept, i."spaceId"
         FROM issues i
         WHERE i."spaceId" = ANY($1::text[])
           AND LOWER(COALESCE(i.current_department, '')) != LOWER($2)
           AND ${sentExistsClause}
         ORDER BY i.id, i."updatedAt" DESC, i."createdAt" DESC
         LIMIT 100 OFFSET 0`,
        [allSpaceIds, dept]
      );
      rowsResult = rr.rows;
    } catch(e: any) { rowsError = e?.message; }

    return Response.json({ ok: true, spaceId, allSpaceIds, dept, countResult, countError, rowsResult, rowsError });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message });
  }
}
