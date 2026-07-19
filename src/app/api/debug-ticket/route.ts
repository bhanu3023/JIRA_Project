import { NextRequest } from 'next/server';
import { pool } from '@/lib/jira-pg-api';

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key') || 'CF-29238';
  const dept = req.nextUrl.searchParams.get('dept') || 'Migration';
  try {
    const r = await pool.query(
      `SELECT i.id, i.key, i."spaceId", i.current_department, i.original_dept, i.dept_statuses,
        (SELECT json_agg(t.*) FROM issue_dept_transitions t WHERE t.issue_id=i.id) AS transitions,
        (SELECT json_agg(q.*) FROM queue_closed_tickets q WHERE q.issue_id=i.id) AS closed_tickets,
        EXISTS(SELECT 1 FROM queue_closed_tickets qct WHERE qct.issue_id=i.id AND LOWER(qct.dept_name)=LOWER($2)) AS or1,
        EXISTS(SELECT 1 FROM issue_dept_transitions t WHERE t.issue_id=i.id AND LOWER(t.from_dept)=LOWER($2) AND LOWER(t.to_dept)!=LOWER($2)) AS or2,
        (i.dept_statuses IS NOT NULL AND (jsonb_exists(i.dept_statuses,$2) OR jsonb_exists(i.dept_statuses,LOWER($2)))) AS or3,
        (LOWER(COALESCE(i.original_dept,''))=LOWER($2) AND LOWER(COALESCE(i.current_department,''))!=LOWER($2)) AS or4
       FROM issues i WHERE i.key=$1`,
      [key, dept]
    );
    return Response.json({ ok: true, data: r.rows[0] ?? null });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message });
  }
}
