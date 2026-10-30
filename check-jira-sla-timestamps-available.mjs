// Read-only: do these 1491 tickets already have jira_sla_due_at/
// jira_sla_start_at populated locally (captured at import time from Jira's
// own native SLA cycle), which could replace the misleading "0.00h actual"
// with Jira's own real measured duration instead of touching the breach
// verdict at all?
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT id, key, cf_key, jira_sla_breached, jira_sla_due_at, jira_sla_start_at, sla_snapshot
    FROM issues
    WHERE sla_snapshot IS NOT NULL AND jsonb_array_length(sla_snapshot) > 0 AND jira_sla_breached = true
  `);
  const matching = rows.filter((r) => (r.sla_snapshot || []).some((x) => x.deptName === 'QA' && x.isBreached && x.actualElapsedMs === 0));
  console.log(`${matching.length} matching tickets total`);

  let bothTimestamps = 0, onlyDue = 0, onlyStart = 0, neither = 0;
  for (const r of matching) {
    if (r.jira_sla_start_at && r.jira_sla_due_at) bothTimestamps++;
    else if (r.jira_sla_due_at) onlyDue++;
    else if (r.jira_sla_start_at) onlyStart++;
    else neither++;
  }
  console.log(`Both start+due timestamps present: ${bothTimestamps}`);
  console.log(`Only due: ${onlyDue}, only start: ${onlyStart}, neither: ${neither}`);

  console.log(`\nSample of 5:`);
  for (const r of matching.slice(0, 5)) {
    console.log(` - ${r.cf_key || r.key}: start=${r.jira_sla_start_at} due=${r.jira_sla_due_at}`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
