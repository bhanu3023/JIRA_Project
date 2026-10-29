// Read-only: CF-33699 and CF-33837 are the last 2 tickets still mismatched
// between Filters (counts them breached) and MBR (doesn't). Both now sit in
// a department called "Pre-Sales-Old", unlike earlier checks. Hypothesis:
// they got REOPENED and rerouted after being resolved, so
// computeSLAInstancesPure no longer trusts the frozen sla_snapshot (which
// clearly has Dev:true) and instead reconstructs Dev's historical instance
// live from dept_sla_log -- possibly against TODAY's SLA policy settings,
// not whatever was in effect when the ticket actually passed through Dev.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT COALESCE(i.cf_key, i.key) AS key, i.priority, i.current_department, i."spaceId",
           s.name AS status_name, s.category AS status_category,
           i.dept_sla_log, i.sla_snapshot, i."resolvedAt"
    FROM issues i
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE i.cf_key = ANY($1::text[]) OR i.key = ANY($1::text[])
  `, [['CF-33699', 'CF-33837']]);

  for (const row of rows) {
    console.log(`\n=== ${row.key} ===`);
    console.log('status:', row.status_name, '| category:', row.status_category, '| current_department:', row.current_department, '| resolvedAt:', row.resolvedAt);
    console.log('dept_sla_log.Dev:', JSON.stringify(row.dept_sla_log?.Dev));
    const devSnap = (row.sla_snapshot || []).find((x) => (x.deptName || '').toLowerCase() === 'dev');
    console.log('frozen snapshot Dev entry:', JSON.stringify(devSnap));

    // Fetch the CURRENT Dev policy the live recompute would use (newest by
    // name, per policy name, same selection computeSLAInstancesPure's
    // historicalInstances loop uses).
    const { rows: policies } = await pool.query(`
      SELECT id, name, dept_name, goals, "updatedAt" FROM sla_policies
      WHERE "spaceId" = $1 AND LOWER(dept_name) = 'dev'
      ORDER BY "updatedAt" DESC
    `, [row.spaceId]);
    console.log(`Current Dev policies in this space (${policies.length}):`);
    for (const p of policies) {
      console.log(`  - "${p.name}" updatedAt=${p.updatedAt.toISOString()} goals=${JSON.stringify(p.goals)}`);
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
