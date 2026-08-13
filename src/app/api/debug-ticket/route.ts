import { NextRequest } from 'next/server';
import { pgPool as dbPool } from '@/lib/pg-pool';

export async function GET(req: NextRequest) {
  const dept = req.nextUrl.searchParams.get('dept') || 'Migration';
  const spaceKey = req.nextUrl.searchParams.get('spaceKey') || 'TESTIN';

  try {
    // Replicate EXACT allSpaceIds logic from jira-pg-api.ts
    let allSpaceIds: string[] = [];
    let subBoardInfo: any = null;
    try {
      const spaceRow = await dbPool.query(
        `SELECT id, COALESCE(sub_board_keys, '{}') AS sub_board_keys FROM spaces WHERE key = $1`,
        [spaceKey]
      );
      if (spaceRow.rows[0]) {
        allSpaceIds.push(spaceRow.rows[0].id);
        const subKeys: string[] = spaceRow.rows[0].sub_board_keys || [];
        subBoardInfo = { mainId: spaceRow.rows[0].id, subKeys };
        if (subKeys.length > 0) {
          const subRows = await dbPool.query(`SELECT id FROM spaces WHERE key = ANY($1::text[])`, [subKeys]);
          for (const sub of subRows.rows) allSpaceIds.push(sub.id);
        }
      }
    } catch {
      const spaceRow = await dbPool.query(`SELECT id FROM spaces WHERE key = $1`, [spaceKey]);
      if (spaceRow.rows[0]) allSpaceIds.push(spaceRow.rows[0].id);
    }
    const spaceId = allSpaceIds[0] ?? null;
    if (!spaceId) return Response.json({ ok: false, error: `Space ${spaceKey} not found` });

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

    // Run full ROWS query with JOINs exactly as in real code
    let rowsResult = null, rowsError = null;
    try {
      const rr = await dbPool.query(
        `SELECT DISTINCT ON (i.id) i.*, sp.key AS space_key,
                s.name AS status_name, s.category AS status_category, s.color AS status_color,
                a.id AS assignee_id, CONCAT(a."firstName",' ',a."lastName") AS assignee_name, a.email AS assignee_email, a."avatarUrl" AS assignee_avatar,
                r.id AS reporter_id, CONCAT(r."firstName",' ',r."lastName") AS reporter_name, r.email AS reporter_email, r."avatarUrl" AS reporter_avatar
         FROM issues i
         LEFT JOIN spaces sp ON sp.id = i."spaceId"
         LEFT JOIN statuses s ON i."statusId" = s.id
         LEFT JOIN users a ON i."assigneeId" = a.id
         LEFT JOIN users r ON i."reporterId" = r.id
         WHERE i."spaceId" = ANY($1::text[])
           AND LOWER(COALESCE(i.current_department, '')) != LOWER($2)
           AND ${sentExistsClause}
         ORDER BY i.id, i."updatedAt" DESC, i."createdAt" DESC
         LIMIT $3 OFFSET $4`,
        [allSpaceIds, dept, 100, 0]
      );
      rowsResult = { count: rr.rows.length, keys: rr.rows.map((r:any) => r.key) };
    } catch(e: any) { rowsError = e?.message; }

    // Run comments fetch — this is NOT in a try/catch in the real code
    let commentsError = null;
    if (rowsResult && (rowsResult as any).count > 0) {
      const fullRows = await dbPool.query(
        `SELECT DISTINCT ON (i.id) i.id FROM issues i
         WHERE i."spaceId" = ANY($1::text[])
           AND LOWER(COALESCE(i.current_department, '')) != LOWER($2)
           AND ${sentExistsClause}
         ORDER BY i.id LIMIT 100`,
        [allSpaceIds, dept]
      );
      const issueIds = fullRows.rows.map((r: any) => r.id);
      try {
        await dbPool.query(
          `SELECT c.*, u."firstName", u."lastName", u.email AS user_email, u."avatarUrl"
           FROM comments c
           LEFT JOIN users u ON u.id = c."authorId"
           WHERE c."issueId" = ANY($1::text[])
           ORDER BY c."createdAt" ASC`,
          [issueIds]
        );
      } catch(e: any) { commentsError = e?.message; }
    }

    // Check for DB triggers on issues table
    const triggers = await dbPool.query(
      `SELECT trigger_name, event_manipulation, action_statement FROM information_schema.triggers WHERE event_object_table = 'issues'`
    );
    // Re-read ticket state NOW (after any recent updates)
    const ticketNow = await dbPool.query(
      `SELECT key, current_department, original_dept, dept_statuses,
        EXISTS(SELECT 1 FROM queue_closed_tickets WHERE issue_id=id AND LOWER(dept_name)=LOWER($1)) AS has_closed_ticket,
        EXISTS(SELECT 1 FROM issue_dept_transitions WHERE issue_id=id AND LOWER(from_dept)=LOWER($1)) AS has_transition
       FROM issues WHERE key='L2B-15087'`,
      [dept]
    );
    return Response.json({ ok: true, spaceId, allSpaceIds, dept, countResult, countError, rowsResult, rowsError, commentsError, triggers: triggers.rows, ticketNow: ticketNow.rows[0] });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message });
  }
}
