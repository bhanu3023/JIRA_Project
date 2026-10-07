// The Queue: Migration + Resolved date fix recovered 8 of a larger gap
// (567 -> 575 live, vs 592 ground truth -- a "belongs to Migration" check
// with NO queue-membership restriction at all). Finds the exact 17 tickets
// still missing and why, to tell apart "a further real bug" from "the
// existing, deliberate queue-membership restriction (worked-on credit only
// counts from a CURRENT queue member) applying consistently here same as it
// already does for Created/Updated/Status". Read-only.
//
// Usage: node check-resolved-date-remaining-gap.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const DATE_FROM = '2026-09-01';
const DATE_TO = '2026-09-30';
const SPACE_KEY = 'TESTIN';
const DEPT = 'Migration';

async function main() {
  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = cqRows[0]?.queues || [];
  const q = queues.find((qq) => String(qq.name || '').toLowerCase() === DEPT.toLowerCase());
  const memberIds = Array.isArray(q?.memberIds) ? q.memberIds : [];

  // Ground truth set (broad belongs-to-Migration, no queue-membership gate)
  const { rows: groundTruth } = await pool.query(`
    SELECT COALESCE(i.cf_key, i.key) AS key, i.id, i.current_department, i."assigneeId", u.email AS assignee_email
    FROM issues i LEFT JOIN users u ON u.id = i."assigneeId"
    WHERE i."resolvedAt" >= $1::date AND i."resolvedAt" < ($2::date + interval '1 day')
      AND (
        LOWER(i.current_department) = LOWER($3)
        OR LOWER(COALESCE(
             i.original_dept,
             (SELECT h."oldValue" FROM issue_history h WHERE h."issueId" = i.id AND h.field = 'department' ORDER BY h."createdAt" ASC LIMIT 1),
             i.current_department
           )) = LOWER($3)
        OR EXISTS (SELECT 1 FROM jsonb_each(COALESCE(i.dept_statuses, '{}'::jsonb)) ds(k, v) WHERE LOWER(k) = LOWER($3) AND LOWER(v->>'category') = 'done')
        OR EXISTS (SELECT 1 FROM user_worked_on_tickets w WHERE w.issue_id = i.id AND LOWER(w.dept) = LOWER($3) AND w.reason != 'passed')
      )
  `, [DATE_FROM, DATE_TO, DEPT]);

  // Live (post-fix, member-restricted) set -- same memberClause/broadenIt
  // logic the real endpoint now runs for Resolved date.
  const { rows: liveSet } = await pool.query(`
    SELECT COALESCE(i.cf_key, i.key) AS key
    FROM issues i
    WHERE i."resolvedAt" >= $1::date AND i."resolvedAt" < ($2::date + interval '1 day')
      AND (
        (
          LOWER(i.current_department) = LOWER($3)
          OR LOWER(COALESCE(
               i.original_dept,
               (SELECT h."oldValue" FROM issue_history h WHERE h."issueId" = i.id AND h.field = 'department' ORDER BY h."createdAt" ASC LIMIT 1),
               i.current_department
             )) = LOWER($3)
          OR (LOWER(i.current_department) != LOWER($3) AND (
               EXISTS (SELECT 1 FROM jsonb_each(COALESCE(i.dept_statuses, '{}'::jsonb)) ds(k, v) WHERE LOWER(k) = LOWER($3) AND LOWER(v->>'category') = 'done')
               OR EXISTS (SELECT 1 FROM user_worked_on_tickets w WHERE w.issue_id = i.id AND LOWER(w.dept) = LOWER($3) AND w.reason != 'passed' AND w.user_id = ANY($4::text[]))
             ))
        )
        AND (
          i."assigneeId" = ANY($4::text[])
          OR (i."assigneeId" IS NULL AND LOWER(i.current_department) = LOWER($3))
          OR EXISTS (SELECT 1 FROM user_worked_on_tickets w4 WHERE w4.issue_id = i.id AND LOWER(w4.dept) = LOWER($3) AND w4.reason != 'passed' AND w4.user_id = ANY($4::text[]))
        )
      )
  `, [DATE_FROM, DATE_TO, DEPT, memberIds]);
  const liveKeys = new Set(liveSet.map((r) => r.key));

  const missing = groundTruth.filter((r) => !liveKeys.has(r.key));
  console.log(`Ground truth: ${groundTruth.length}, Live (post-fix): ${liveKeys.size}, Missing: ${missing.length}`);

  if (missing.length) {
    const memberSet = new Set(memberIds);
    console.log('\nFor each missing ticket: is the assignee a CURRENT Migration queue member, and does anyone on the queue have a worked-on-Migration record for it?');
    for (const r of missing) {
      const { rows: workedRows } = await pool.query(
        `SELECT wu.email, w.dept, w.reason FROM user_worked_on_tickets w JOIN users wu ON wu.id = w.user_id WHERE w.issue_id = $1 AND LOWER(w.dept) = LOWER($2)`,
        [r.id, DEPT]
      );
      const assigneeIsMember = r.assigneeId ? memberSet.has(r.assigneeId) : null;
      console.log(`  ${r.key}: current_dept=${r.current_department} assignee=${r.assignee_email || '(unassigned)'} assignee_is_queue_member=${assigneeIsMember} worked_on_rows=${JSON.stringify(workedRows)}`);
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
