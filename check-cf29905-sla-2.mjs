// Follow-up to check-cf29905-sla.mjs. The frozen Migration SLA snapshot's
// startedAt (Aug 22) predates the ticket's own createdAt (Aug 28) by 6 days,
// which is mathematically consistent with
// startedAt = resolvedAt - priorElapsedMs (computeSLAInstancesPure,
// jira-pg-api.ts ~line 2658) IF issue.resolvedAt is stuck at the ticket's
// FIRST resolution (Aug 28 21:00:00, by Siva Kota) while dept_sla_log's
// Migration entry kept accumulating elapsed time up to a later pause at
// Sep 4 15:50:09 (585M ms ~ 6d18h, matching "Resolved in 6d 18h"). The first
// diagnostic's history query (field IN department/status/priority) showed no
// further status transition after the Aug 28 21:18:52 reopen into Migration,
// which doesn't explain what caused the Sep 4 pause. This pulls the full
// issue row (status, dept_statuses, resolve_override_depts) and the COMPLETE
// issue_history (every field, not just 3) to find out what actually happened
// around Sep 4, and whether resolvedAt genuinely never got updated. Read-only.
//
// Usage: node check-cf29905-sla-2.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'CF-29905';

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, i.key, i."statusId", i."resolvedAt", i.current_department, i.dept_statuses,
           i.resolve_override_depts, i.original_dept, i."updatedAt",
           s.name as status_name, s.category as status_category
    FROM issues i
    LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE i.cf_key = $1 OR i.key = $1 LIMIT 1
  `, [KEY]);
  const issue = rows[0];
  if (!issue) { console.log(`${KEY} not found`); await pool.end(); return; }

  console.log(`=== ${KEY} current state ===`);
  console.log('statusId/name/category:', issue.statusId, issue.status_name, issue.status_category);
  console.log('resolvedAt:', issue.resolvedAt);
  console.log('current_department:', issue.current_department);
  console.log('dept_statuses:', JSON.stringify(issue.dept_statuses, null, 2));
  console.log('resolve_override_depts:', JSON.stringify(issue.resolve_override_depts));
  console.log('original_dept:', issue.original_dept);
  console.log('updatedAt:', issue.updatedAt);

  const { rows: history } = await pool.query(`
    SELECT field, "oldValue", "newValue", "authorName", "createdAt"
    FROM issue_history WHERE "issueId" = $1
    ORDER BY "createdAt" ASC
  `, [issue.id]);
  console.log('\n=== FULL issue_history (all fields) ===');
  for (const h of history) {
    console.log(`${h.createdAt.toISOString()} [${h.field}] "${h.oldValue}" -> "${h.newValue}" (by ${h.authorName})`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
