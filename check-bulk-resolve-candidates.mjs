// Read-only: check the current state of the 25 tickets the user wants bulk-
// resolved, so the resolve can go through the real app logic (SLA bookkeeping,
// history, notifications) correctly instead of a raw status-column flip.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const KEYS = [
  'CF-9889', 'CF-10256', 'CF-10426', 'CF-14614', 'CF-14921', 'CF-14951', 'CF-14986',
  'CF-18386', 'CF-19061', 'CF-19328', 'CF-19362', 'CF-19369', 'CF-19862', 'CF-20168',
  'CF-22183', 'CF-24400', 'CF-24430', 'CF-24990', 'CF-25059', 'CF-25121', 'CF-25171',
  'CF-25172', 'CF-25292', 'CF-27197', 'CF-30003',
];

async function main() {
  const { rows } = await pool.query(
    `SELECT i.key, i.cf_key, i.id, i."spaceId", i.current_department, i."assigneeId",
            i."resolvedAt", s.name AS status_name, s.category AS status_category, sp.key AS space_key,
            (SELECT COUNT(*) FROM issue_worklogs w WHERE w."issueId" = i.id) AS worklog_count
     FROM issues i
     LEFT JOIN statuses s ON s.id = i."statusId"
     LEFT JOIN spaces sp ON sp.id = i."spaceId"
     WHERE i.key = ANY($1::text[]) OR i.cf_key = ANY($1::text[])
     ORDER BY i.key`,
    [KEYS],
  );
  const found = new Set(rows.map((r) => r.cf_key || r.key));
  for (const k of KEYS) if (!found.has(k)) console.log(`NOT FOUND: ${k}`);

  for (const r of rows) {
    console.log(`${r.cf_key || r.key}  space=${r.space_key}  dept=${r.current_department}  status="${r.status_name}" (${r.status_category})  assignee=${r.assigneeId ? 'yes' : 'NONE'}  resolvedAt=${r.resolvedAt || 'null'}  worklogs=${r.worklog_count}`);
  }

  // Check what "Resolved" status options exist for QA in each space seen above
  const spaceIds = [...new Set(rows.map((r) => r.spaceId))];
  for (const spaceId of spaceIds) {
    const { rows: statusRows } = await pool.query(
      `SELECT id, name, category FROM statuses WHERE "spaceId" = $1 AND category = 'done'`,
      [spaceId],
    );
    console.log(`\nSpace ${spaceId} done-category statuses: ${statusRows.map((s) => `${s.name} (${s.id})`).join(', ') || 'NONE'}`);
    const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = (SELECT key FROM spaces WHERE id = $1)`, [spaceId]);
    const qaQueue = (cq[0]?.queues || []).find((q) => (q.name || '').trim().toLowerCase() === 'qa');
    if (qaQueue) {
      console.log(`QA queue statuses: ${(qaQueue.queueStatuses || []).map((s) => `${s.name} (${s.category})`).join(', ')}`);
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
