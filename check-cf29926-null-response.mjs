// Lakshmi Prasanna IS the current assignee on CF-29926 (status Resolved),
// but its ticket-level responseTimeHours is null -- meaning
// computeResponseTimeHours found literally no status-history row at or
// after its anchor (dept_sla_started_at, or createdAt fallback). Dumps the
// raw timestamps to see why.
//
// Read-only.
//
// Usage: node check-cf29926-null-response.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT id, cf_key, key, current_department, dept_sla_started_at, "createdAt", "resolvedAt" FROM issues WHERE cf_key = 'CF-29926' OR key = 'CF-29926'`
  );
  const issue = rows[0];
  console.log(`current_department: ${issue.current_department}`);
  console.log(`dept_sla_started_at: ${issue.dept_sla_started_at ? new Date(issue.dept_sla_started_at).toISOString() : 'NULL'}`);
  console.log(`createdAt: ${issue.createdAt.toISOString()}`);
  console.log(`resolvedAt: ${issue.resolvedAt ? new Date(issue.resolvedAt).toISOString() : 'NULL'}`);

  console.log('\nAll history (every field, not just status):');
  const { rows: hist } = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorEmail", "createdAt" FROM issue_history WHERE "issueId" = $1 ORDER BY "createdAt" ASC`,
    [issue.id]
  );
  for (const h of hist) console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" (by ${h.authorEmail})`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
