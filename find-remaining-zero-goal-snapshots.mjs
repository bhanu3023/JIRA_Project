// Broader, more reliable catch-all than relying on the specific
// issue_history marker my bulk scripts used: directly finds any
// RESOLVED ticket whose frozen sla_snapshot still has a Migration or
// Dev policy entry with goalDurationMs=0 -- the unmistakable sign of
// a stale pre-fix snapshot, regardless of HOW/WHEN its priority got
// corrected (bulk script, manual edit, anything). Read-only.
//
// Usage: node find-remaining-zero-goal-snapshots.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT id, COALESCE(cf_key, key) AS key, priority, sla_snapshot
    FROM issues
    WHERE sla_snapshot IS NOT NULL
  `);
  const stale = [];
  for (const r of rows) {
    for (const entry of (r.sla_snapshot || [])) {
      if ((entry.deptName === 'Migration' || entry.deptName === 'Dev') && entry.goalDurationMs === 0) {
        stale.push(r.key);
        break;
      }
    }
  }
  console.log(`${stale.length} tickets still have a stale 0h-goal snapshot entry for Migration/Dev:`);
  console.log(stale.join(', '));
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
