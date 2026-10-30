// Read-only: fresh, live re-check of CF-34629's Infra SLA breach -- the
// ticket has new activity since the last check (now shows Resolved), so
// don't rely on a prior snapshot in conversation; pull current dept_sla_log
// and sla_snapshot directly.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT COALESCE(cf_key,key) AS key, current_department, "resolvedAt", dept_sla_log, sla_snapshot, sla_waivers
    FROM issues WHERE cf_key = 'CF-34629' OR key = 'CF-34629'
  `);
  const row = rows[0];
  console.log('current_department:', row.current_department, '| resolvedAt:', row.resolvedAt);
  console.log('\ndept_sla_log.Infra:', JSON.stringify(row.dept_sla_log?.Infra, null, 2));

  const infraSnap = (row.sla_snapshot || []).find((x) => (x.deptName || '').toLowerCase() === 'infra');
  console.log('\nfrozen snapshot Infra entry:', JSON.stringify(infraSnap, null, 2));

  const waivers = row.sla_waivers || {};
  if (infraSnap) {
    const waived = !!waivers[infraSnap.policyId];
    console.log('\nWaived?', waived);
    console.log('FINAL VERDICT (snapshot-based): Infra', infraSnap.isBreached && !waived ? 'IS BREACHED' : 'is NOT breached');
  } else if (row.dept_sla_log?.Infra) {
    const e = row.dept_sla_log.Infra;
    console.log('\nNo frozen snapshot entry for Infra -- raw elapsed_ms:', e.elapsed_ms, `(${(e.elapsed_ms/3600000).toFixed(2)}h)`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
