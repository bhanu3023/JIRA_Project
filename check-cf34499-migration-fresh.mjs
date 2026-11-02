// Read-only: CF-34499's Migration card now shows Start AFTER Due (backwards)
// -- pull the current raw dept_sla_log.Migration and frozen snapshot entry
// to see exactly what's being computed right now.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.dept_sla_log, i.sla_snapshot, i.current_department
    FROM issues i WHERE i.cf_key = 'CF-34499' OR i.key = 'CF-34499'
  `);
  const r = rows[0];
  console.log('current_department:', r.current_department);
  console.log('\ndept_sla_log.Migration (raw, live):', JSON.stringify(r.dept_sla_log?.Migration, null, 2));

  const migSnap = (r.sla_snapshot || []).find((x) => (x.deptName || '').toLowerCase() === 'migration');
  console.log('\nFrozen snapshot Migration entry (as stored, BEFORE any self-heal logic runs):', JSON.stringify(migSnap, null, 2));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
