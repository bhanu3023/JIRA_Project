// Read-only: CF-34482's own Dev dept_sla_log says NOT breached (6.79h of a
// 12h goal), yet the live Filters page under Queue=Dev shows "SLA Breached:
// Yes". The likely cause: a FROZEN sla_snapshot captured earlier (e.g. the
// last time the ticket detail page computed it, possibly while the ticket's
// CURRENT department was something other than Dev) short-circuits
// computeSlaBreachedAndOverdue entirely for any resolved ticket that has
// one -- see its "if (isResolved && sla_snapshot...) return {...}" branch,
// which runs BEFORE any dept-scoping logic and ignores deptParam completely.
// Dumps the raw snapshot/current-department/dept_sla_log for a few of the
// tickets shown as breached under Queue=Dev to confirm.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = ['CF-34482', 'CF-34474', 'CF-34472', 'CF-34468', 'CF-34464', 'CF-34463', 'CF-34480', 'CF-34477'];

async function main() {
  for (const cfKey of KEYS) {
    const { rows } = await pool.query(
      `SELECT key, cf_key, current_department, priority, dept_sla_log, sla_snapshot, sla_waivers, jira_sla_breached
       FROM issues WHERE cf_key = $1 OR key = $1`,
      [cfKey]
    );
    const r = rows[0];
    if (!r) { console.log(`${cfKey}: NOT FOUND`); continue; }
    console.log(`\n--- ${cfKey} (real key ${r.key}) ---`);
    console.log('current_department:', r.current_department, '| priority:', r.priority);
    console.log('dept_sla_log:', JSON.stringify(r.dept_sla_log));
    console.log('sla_snapshot:', JSON.stringify(r.sla_snapshot));
    console.log('sla_waivers:', JSON.stringify(r.sla_waivers));
    console.log('jira_sla_breached:', r.jira_sla_breached);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
