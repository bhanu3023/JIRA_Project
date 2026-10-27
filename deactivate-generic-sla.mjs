// One-time data fix, per explicit request: deactivate the space-wide
// "Time to Resolution" SLA policy (pg_w2njw9dfj9, dept_name=null, 6h goal
// for medium priority) that was silently applying on top of every
// department's own dedicated policy, causing tickets to show as breached
// under this generic 6h rule even when their actual department's own
// (often longer) SLA goal was fine. Confirmed as the root cause of CF-34521
// and the earlier CF-3448x mismatches. Pure toggle, reversible from the
// Settings > SLA page's own Enabled/Disabled switch if ever needed again.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const POLICY_ID = 'pg_w2njw9dfj9';

async function main() {
  const { rows: before } = await pool.query(`SELECT id, name, status, dept_name FROM sla_definitions WHERE id = $1`, [POLICY_ID]);
  console.log('Before:', before[0]);
  if (!before[0]) { console.log('Policy not found -- nothing to do.'); await pool.end(); return; }
  if (before[0].status !== 'active') { console.log('Already inactive -- nothing to do.'); await pool.end(); return; }

  const { rows: after } = await pool.query(
    `UPDATE sla_definitions SET status = 'inactive', "updatedAt" = NOW() WHERE id = $1 RETURNING id, name, status, dept_name`,
    [POLICY_ID]
  );
  console.log('After:', after[0]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
