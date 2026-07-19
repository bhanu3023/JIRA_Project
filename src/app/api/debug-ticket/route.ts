import { NextRequest } from 'next/server';
import { Pool } from 'pg';

const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:neutara123@localhost:5433/neutara_db',
});

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key') || 'L2B-15087';
  const dept = req.nextUrl.searchParams.get('dept') || 'Migration';
  const spaceKey = req.nextUrl.searchParams.get('spaceKey') || 'TESTIN';

  try {
    // Get the space ID for this spaceKey
    const spaceRow = await dbPool.query(`SELECT id, key FROM spaces WHERE UPPER(key) = UPPER($1)`, [spaceKey]);
    const spaceId = spaceRow.rows[0]?.id ?? null;

    // Get ticket data
    const ticketRow = await dbPool.query(
      `SELECT i.id, i.key, i."spaceId", i.current_department, i.original_dept, i.dept_statuses,
        (SELECT json_agg(row_to_json(t)) FROM issue_dept_transitions t WHERE t.issue_id=i.id) AS transitions,
        (SELECT json_agg(row_to_json(q)) FROM queue_closed_tickets q WHERE q.issue_id=i.id) AS closed_tickets
       FROM issues i WHERE i.key=$1`,
      [key]
    );
    const ticket = ticketRow.rows[0] ?? null;

    // Run the exact Sent/Watching count query
    let countResult = null;
    let countError = null;
    if (spaceId) {
      try {
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
        const cr = await dbPool.query(
          `SELECT i.key, i."spaceId", i.current_department, i.original_dept,
            (${sentExistsClause}) AS sent_match
           FROM issues i
           WHERE i."spaceId" = ANY($1::text[])
             AND LOWER(COALESCE(i.current_department,'')) != LOWER($2)`,
          [[spaceId], dept]
        );
        countResult = { total: cr.rows.filter((r:any) => r.sent_match).length, rows: cr.rows };
      } catch(e: any) {
        countError = e?.message;
      }
    }

    return Response.json({
      ok: true,
      spaceId,
      ticket,
      ticketSpaceIdMatchesSpace: ticket ? ticket.spaceId === spaceId : null,
      countResult,
      countError,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message });
  }
}
