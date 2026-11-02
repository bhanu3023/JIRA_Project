// Read-only: CF-34197's Migration card correctly shows "Resolved in 41m --
// within the SLA goal" (isBreached should be false), but the History tab's
// badge on the same resolve event reads "SLA Breached by 21h 45m --
// Migration" (wasBreached=true). Pull the raw sla_snapshot Migration entry
// and the actual resolve-event history rows to find exactly why
// isOwnResolution's exact-timestamp match isn't landing.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, i.sla_snapshot, i."resolvedAt", i.current_department
    FROM issues i WHERE i.cf_key = 'CF-34197' OR i.key = 'CF-34197'
  `);
  const r = rows[0];
  console.log('issue.resolvedAt (top-level column):', r.resolvedAt);
  const migSnap = (r.sla_snapshot || []).find((x) => (x.deptName || '').toLowerCase() === 'migration');
  console.log('\nMigration frozen snapshot entry:', JSON.stringify(migSnap, null, 2));

  const { rows: statusHist } = await pool.query(`
    SELECT "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
    WHERE "issueId" = $1 AND field = 'status' ORDER BY "createdAt" ASC
  `, [r.id]);
  console.log('\nAll status-change history rows:');
  for (const h of statusHist) console.log(`  [${h.createdAt.toISOString()}] ${h.authorName}: ${h.oldValue} -> ${h.newValue}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
