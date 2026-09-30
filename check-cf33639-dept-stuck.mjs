// CF-33639: status changed Resolved -> Routed to QA -> In Progress, but
// Department still shows Migration the whole time. Need to see whether the
// dept handoff to QA ever actually wrote current_department, and whether
// something moved it back, or it never moved at all. Read-only.
//
// Usage: node check-cf33639-dept-stuck.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT i.id, i.key, i.cf_key, i."spaceId", i.current_department, i.dept_statuses,
            i.dept_assignees, i.dept_sla_log, i."statusId", s.name AS status_name, s.category
     FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
     WHERE i.key = 'CF-33639' OR i.cf_key = 'CF-33639'`
  );
  const t = rows[0];
  if (!t) { console.log('Not found'); await pool.end(); return; }
  console.log('current_department:', t.current_department);
  console.log('statusId/name/category:', t.statusId, t.status_name, t.category);
  console.log('dept_statuses:', JSON.stringify(t.dept_statuses, null, 2));
  console.log('dept_assignees:', JSON.stringify(t.dept_assignees, null, 2));
  console.log('dept_sla_log:', JSON.stringify(t.dept_sla_log, null, 2));

  const { rows: hist } = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
     WHERE "issueId" = $1 AND (field ILIKE '%department%' OR field = 'status')
     ORDER BY "createdAt" ASC`,
    [t.id]
  );
  console.log('\nRelevant history:');
  for (const h of hist) {
    console.log(`  [${h.createdAt.toISOString()}] ${h.authorName}: ${h.field}: "${h.oldValue}" -> "${h.newValue}"`);
  }

  // Check what statuses named "Routed to QA" / "In Progress" exist for this
  // space, and whether they're real global rows or purely queue-scoped
  const { rows: statuses } = await pool.query(
    `SELECT id, name, category FROM statuses WHERE "spaceId" = $1 AND (name ILIKE '%routed to qa%' OR name ILIKE 'in progress')`,
    [t.spaceId]
  );
  console.log('\nMatching real global statuses for this space:', JSON.stringify(statuses, null, 2));

  const { rows: cq } = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  for (const row of cq.rows) {
    const queues = Array.isArray(row.queues) ? row.queues : [];
    for (const q of queues) {
      const qsts = Array.isArray(q.queueStatuses) ? q.queueStatuses : [];
      const match = qsts.find((s) => /routed to qa/i.test(s.name || '') || /^in progress$/i.test(s.name || ''));
      if (match) console.log(`Queue "${q.name}" (space ${row.space_key}) has status: ${JSON.stringify(match)}`);
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
