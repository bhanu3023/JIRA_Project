// Read-only: CF-33117 shows "SLA Breached: Yes, by Mayank Jain" under a
// Dev-scoped Filters view, but Mayank only held it ~6 minutes before
// handoff to QA (which has been breaching live for 1000+ hours). Check
// whether Dev's OWN dept_sla_log genuinely shows a breach (elapsed >= its
// own goal), or whether QA's real breach is being miscounted as Dev's.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT COALESCE(cf_key,key) AS key, dept_sla_log, priority, "spaceId" FROM issues
    WHERE cf_key = 'CF-33117' OR key = 'CF-33117'
  `);
  const r = rows[0];
  console.log('dept_sla_log.Dev:', JSON.stringify(r.dept_sla_log?.Dev, null, 2));
  console.log('dept_sla_log.QA:', JSON.stringify(r.dept_sla_log?.QA, null, 2));
  console.log('priority:', r.priority);

  const { rows: policies } = await pool.query(`
    SELECT name, dept_name, status, goals FROM sla_definitions
    WHERE "spaceId" = $1 AND LOWER(dept_name) = 'dev' AND status = 'active'
  `, [r.spaceId]);
  console.log('\nActive Dev policies:', JSON.stringify(policies, null, 2));

  const devElapsed = r.dept_sla_log?.Dev?.elapsed_ms;
  console.log('\nDev elapsed_ms:', devElapsed, `(${devElapsed ? (devElapsed/60000).toFixed(1) : 0} minutes)`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
