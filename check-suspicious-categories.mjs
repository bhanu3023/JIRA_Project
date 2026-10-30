// Read-only: investigate the two biggest suspicious categories from the
// full breach audit:
// 1) "elapsed < goal but breached" with elapsed=0 -- is this my audit
//    script wrongly reading a stale elapsed_ms=0 for a STILL-RUNNING
//    instance (whose real current elapsed is now-started_at, not the
//    stored value, which only updates on pause/resolve)?
// 2) "no real tracking, no jira_sla_breached, but breached" -- are these
//    RESOLVED tickets carrying a frozen sla_snapshot from before today's
//    fixes, which wouldn't self-correct just by fixing the live code path?
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log('=== Category 1 (elapsed=0, allegedly not breached) ===');
  for (const key of ['CF-34233', 'CF-19862', 'CF-33117']) {
    const { rows } = await pool.query(`
      SELECT COALESCE(cf_key,key) AS key, current_department, dept_sla_log, "resolvedAt", sla_snapshot
      FROM issues WHERE cf_key = $1 OR key = $1
    `, [key]);
    const r = rows[0];
    console.log(`\n${key}: current_department=${r.current_department}, resolvedAt=${r.resolvedAt}`);
    console.log('dept_sla_log:', JSON.stringify(r.dept_sla_log));
    console.log('sla_snapshot:', JSON.stringify(r.sla_snapshot));
  }

  console.log('\n\n=== Category 2 (no tracking, no jira flag, still breached) ===');
  for (const key of ['CF-20240', 'CF-25292', 'CF-22904', 'CF-19849']) {
    const { rows } = await pool.query(`
      SELECT COALESCE(cf_key,key) AS key, current_department, dept_sla_log, "resolvedAt", sla_snapshot, jira_sla_breached, priority
      FROM issues WHERE cf_key = $1 OR key = $1
    `, [key]);
    const r = rows[0];
    console.log(`\n${key}: current_department=${r.current_department}, resolvedAt=${r.resolvedAt}, priority=${r.priority}, jira_sla_breached=${r.jira_sla_breached}`);
    console.log('dept_sla_log:', JSON.stringify(r.dept_sla_log));
    console.log('sla_snapshot:', JSON.stringify(r.sla_snapshot));
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
