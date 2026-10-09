// Clears sla_snapshot for tickets flagged by check-sla-system-health.mjs as
// falseResolvedDept (frozen isCompleted:true for the current department
// while dept_sla_log says that department's clock is still "running" -- the
// CF-29397 class, fixed going forward by the isResolved consistency guard,
// but already-frozen tickets predate that fix) or falseNegativeBreach (real
// elapsed time now exceeds the goal but the frozen snapshot still says
// not-breached -- the department's tracked time grew after the snapshot
// froze). Clearing the snapshot (not editing it) lets the SAME existing
// lazy-recompute-on-view mechanism every other ticket already uses produce
// a correct, current, internally-consistent result next time anyone views
// it -- this does not fabricate or guess any value itself.
//
// Usage: node backfill-clear-bad-snapshots.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT id, COALESCE(cf_key, key) AS key, current_department, dept_sla_log, sla_snapshot
    FROM issues
    WHERE sla_snapshot IS NOT NULL AND jsonb_array_length(sla_snapshot) > 0
  `);

  const toClear = [];
  for (const row of rows) {
    const deptLog = row.dept_sla_log || {};
    const curDept = (row.current_department || '').trim().toLowerCase();
    const curDeptKey = Object.keys(deptLog).find((k) => k.toLowerCase() === curDept);
    let flag = false;

    for (const inst of row.sla_snapshot || []) {
      const isCurrentDeptInstance = (inst.deptName || '').trim().toLowerCase() === curDept;
      if (isCurrentDeptInstance && inst.isCompleted && curDeptKey && deptLog[curDeptKey]?.status === 'running') {
        flag = true;
      }
      if (typeof inst.actualElapsedMs === 'number' && typeof inst.goalDurationMs === 'number'
        && !inst.isBreached && inst.actualElapsedMs >= inst.goalDurationMs) {
        flag = true;
      }
    }
    if (flag) toClear.push(row);
  }

  console.log(`Found ${toClear.length} tickets to clear (false-resolved-dept or false-negative-breach).\n`);
  for (const row of toClear) {
    await pool.query(`UPDATE issues SET sla_snapshot = NULL WHERE id = $1`, [row.id]);
    console.log(`  Cleared: ${row.key}`);
  }
  console.log(`\nCleared: ${toClear.length}. Each will recompute fresh (correctly) the next time it's viewed.`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
