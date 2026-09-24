// User wants to verify whether CF-33286 and CF-33228 are genuinely SLA
// breached "by Amulya A" as Filters shows, or if this is inaccurate --
// following the same real-data-verification methodology used throughout
// this session for SLA breach accuracy checks. Pulls each ticket's raw SLA
// data (jira_sla_breached, dept_sla_started_at, dept_sla_log, resolvedAt),
// current assignee, and full department/status history to confirm the
// timeline supports the breach and the "by Amulya A" attribution.
//
// Read-only.
//
// Usage: node check-cf33286-cf33228-breach.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = ['CF-33286', 'CF-33228'];

async function main() {
  for (const key of KEYS) {
    console.log(`\n\n========== ${key} ==========`);
    const { rows } = await pool.query(
      `SELECT i.id, i.current_department, i.priority, i."statusId", s.name AS status_name, s.category AS status_category,
              i.jira_sla_breached, i.jira_sla_due_at, i.jira_sla_start_at,
              i.dept_sla_started_at, i.dept_sla_log, i."resolvedAt", i."createdAt",
              i."assigneeId", au.email AS assignee_email, au."firstName" AS assignee_first
       FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
       LEFT JOIN users au ON au.id = i."assigneeId"
       WHERE i.cf_key = $1 OR i.key = $1`,
      [key]
    );
    if (!rows.length) { console.log('NOT FOUND'); continue; }
    const r = rows[0];
    console.log(`current_department: ${r.current_department}   priority: ${r.priority}   status: ${r.status_name} (${r.status_category})`);
    console.log(`current assignee: ${r.assignee_first} <${r.assignee_email}>`);
    console.log(`createdAt: ${r.createdAt.toISOString()}`);
    console.log(`resolvedAt: ${r.resolvedAt ? new Date(r.resolvedAt).toISOString() : 'NULL (still open)'}`);
    console.log(`jira_sla_breached: ${r.jira_sla_breached}`);
    console.log(`jira_sla_due_at: ${r.jira_sla_due_at ? new Date(r.jira_sla_due_at).toISOString() : 'NULL'}`);
    console.log(`dept_sla_started_at: ${r.dept_sla_started_at ? new Date(r.dept_sla_started_at).toISOString() : 'NULL'}`);
    console.log(`dept_sla_log: ${JSON.stringify(r.dept_sla_log)}`);

    console.log('\nFull department/status/assignee history:');
    const { rows: hist } = await pool.query(
      `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt" FROM issue_history
       WHERE "issueId" = $1 AND field IN ('department','status','assignee') ORDER BY "createdAt" ASC`,
      [r.id]
    );
    for (const h of hist) console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" (by ${h.authorName || h.authorEmail || 'system'})`);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
