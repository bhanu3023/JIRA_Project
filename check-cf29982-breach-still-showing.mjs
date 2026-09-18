// User reports CF-29982 still shows "SLA Breached: Yes" in both Filters and
// MBR. Earlier this session, the ticket-detail page's raw-column query was
// found to be MISSING jira_sla_breached/jira_sla_due_at/jira_sla_start_at
// entirely (silently reading as undefined/false) while Filters/MBR read them
// correctly -- that fix made the detail page AGREE with Filters (both would
// show breached), it did not change what Filters/MBR show. So before
// assuming Filters is now wrong, pull the raw ground truth: jira_sla_breached
// column, dept_sla_log/dept_sla_started_at bookkeeping, priority, time spent,
// and the applicable SLA policy duration for this priority/department, to
// determine whether "Breached: Yes" is actually correct or not.
//
// Read-only.
//
// Usage: node check-cf29982-breach-still-showing.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT i.id, i.key, i.cf_key, i."spaceId", i.current_department, i.priority, i."statusId",
            i.jira_sla_breached, i.jira_sla_due_at, i.jira_sla_start_at,
            i.dept_sla_started_at, i.dept_sla_log, i."resolvedAt", i."createdAt", i.sla_waivers,
            s.name AS status_name, s.category AS status_category
     FROM issues i LEFT JOIN statuses s ON i."statusId" = s.id
     WHERE i.cf_key = 'CF-29982' OR i.key = 'CF-29982'`
  );
  if (!rows.length) { console.log('CF-29982: NOT FOUND'); await pool.end(); return; }
  const r = rows[0];
  console.log('=== Raw issue data ===');
  console.log(`current_department: ${r.current_department}`);
  console.log(`priority: ${r.priority}`);
  console.log(`status: ${r.status_name} (${r.status_category})`);
  console.log(`resolvedAt: ${r.resolvedAt}`);
  console.log(`createdAt: ${r.createdAt}`);
  console.log(`jira_sla_breached: ${r.jira_sla_breached}`);
  console.log(`jira_sla_due_at: ${r.jira_sla_due_at}`);
  console.log(`jira_sla_start_at: ${r.jira_sla_start_at}`);
  console.log(`dept_sla_started_at: ${r.dept_sla_started_at}`);
  console.log(`dept_sla_log: ${JSON.stringify(r.dept_sla_log)}`);
  console.log(`sla_waivers: ${JSON.stringify(r.sla_waivers)}`);

  console.log('\n=== Applicable SLA policy ===');
  const { rows: policies } = await pool.query(
    `SELECT * FROM sla_policies WHERE "spaceId" = $1`,
    [r.spaceId]
  );
  console.log(JSON.stringify(policies, null, 2));

  console.log('\n=== Status/department history ===');
  const { rows: hist } = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
     WHERE "issueId" = $1 AND field IN ('status','department') ORDER BY "createdAt" ASC`,
    [r.id]
  );
  for (const h of hist) console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" (by ${h.authorName})`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
