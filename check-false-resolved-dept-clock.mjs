// Quantifies the CF-29397 class of bug: a frozen sla_snapshot entry marked
// isCompleted:true for the ticket's CURRENT department, while that same
// department's dept_sla_log entry still reads status:"running" (never
// actually paused/stopped) -- proof the "resolved" reading came from a
// stale, cross-department-propagated dept_statuses flag rather than this
// department genuinely finishing. The forward fix (isResolved's new
// deptClockGenuinelyStopped guard) only prevents this for FUTURE
// computations; already-frozen tickets need this counted separately before
// deciding on a backfill. Read-only.
//
// Usage: node check-false-resolved-dept-clock.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT key, cf_key, current_department, dept_sla_log, sla_snapshot
    FROM issues
    WHERE sla_snapshot IS NOT NULL AND jsonb_array_length(sla_snapshot) > 0
      AND dept_sla_log IS NOT NULL
  `);
  console.log(`Checking ${rows.length} resolved tickets with dept_sla_log present.\n`);

  let affected = 0;
  const samples = [];
  for (const row of rows) {
    const dept = (row.current_department || '').trim().toLowerCase();
    if (!dept) continue;
    const deptLog = row.dept_sla_log || {};
    const curKey = Object.keys(deptLog).find((k) => k.toLowerCase() === dept);
    if (!curKey) continue;
    const entry = deptLog[curKey];
    if (entry?.status !== 'running') continue; // clock WAS stopped -- not this bug

    const snapshot = row.sla_snapshot || [];
    const curDeptInstance = snapshot.find((inst) => (inst.deptName || '').trim().toLowerCase() === dept);
    if (!curDeptInstance || !curDeptInstance.isCompleted) continue; // not frozen as resolved for this dept -- fine

    affected++;
    if (samples.length < 25) {
      samples.push({
        key: row.cf_key || row.key,
        dept: row.current_department,
        deptLogStatus: entry.status,
        deptLogElapsedMin: ((entry.elapsed_ms || 0) / 60000).toFixed(1),
        snapshotIsBreached: curDeptInstance.isBreached,
        snapshotResolvedAt: curDeptInstance.resolvedAt,
      });
    }
  }

  console.log(`=== Sample of tickets falsely frozen as "resolved" for their current department (${affected} total) ===`);
  for (const s of samples) {
    console.log(`  ${s.key} [${s.dept}] dept_sla_log.status=${s.deptLogStatus} elapsed=${s.deptLogElapsedMin}min  snapshot.isBreached=${s.snapshotIsBreached} snapshot.resolvedAt=${s.snapshotResolvedAt}`);
  }
  console.log(`\nTotal affected: ${affected}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
