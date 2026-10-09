// Comprehensive, whole-database SLA health check -- covers every failure
// class found and fixed this session, to give a real quantified answer
// instead of spot-checking individual tickets. Read-only.
//
//   1. Impossible Start (before the ticket's own createdAt)
//   2. Impossible Due (before Start)
//   3. False-resolved dept (frozen isCompleted:true for current dept, but
//      dept_sla_log[currentDept].status is still 'running' -- the CF-29397
//      class, should be fixed going forward by the isResolved consistency
//      guard, checking here whether any NEW occurrences exist)
//   4. Stale resolvedAt (dept_sla_log[currentDept].paused_at clearly AFTER
//      issue.resolvedAt -- the CF-29905/CF-29355 class)
//   5. isBreached says true but actualElapsedMs < goalDurationMs (false
//      positive breach)
//   6. isBreached says false but actualElapsedMs >= goalDurationMs (false
//      negative -- a real breach not being flagged)
//
// Usage: node check-sla-system-health.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT id, COALESCE(cf_key, key) AS key, "createdAt", "resolvedAt", current_department,
           dept_sla_log, sla_snapshot
    FROM issues
    WHERE sla_snapshot IS NOT NULL AND jsonb_array_length(sla_snapshot) > 0
  `);
  console.log(`Checking ${rows.length} resolved tickets with a frozen SLA snapshot.\n`);

  const issues = {
    impossibleStart: [],
    impossibleDue: [],
    falseResolvedDept: [],
    staleResolvedAt: [],
    falsePositiveBreach: [],
    falseNegativeBreach: [],
  };

  for (const row of rows) {
    const createdMs = new Date(row.createdAt).getTime();
    const deptLog = row.dept_sla_log || {};
    const curDept = (row.current_department || '').trim().toLowerCase();
    const curDeptKey = Object.keys(deptLog).find((k) => k.toLowerCase() === curDept);

    for (const inst of row.sla_snapshot || []) {
      if (inst.startedAt && new Date(inst.startedAt).getTime() < createdMs - 1000) {
        issues.impossibleStart.push(row.key);
      }
      if (inst.startedAt && inst.dueTime && new Date(inst.dueTime).getTime() < new Date(inst.startedAt).getTime()) {
        issues.impossibleDue.push(row.key);
      }
      const isCurrentDeptInstance = (inst.deptName || '').trim().toLowerCase() === curDept;
      if (isCurrentDeptInstance && inst.isCompleted && curDeptKey && deptLog[curDeptKey]?.status === 'running') {
        issues.falseResolvedDept.push(row.key);
      }
      if (typeof inst.actualElapsedMs === 'number' && typeof inst.goalDurationMs === 'number') {
        if (inst.isBreached && !inst.waived && inst.actualElapsedMs < inst.goalDurationMs) {
          issues.falsePositiveBreach.push(`${row.key} [${inst.deptName}] elapsed=${(inst.actualElapsedMs/3600000).toFixed(2)}h goal=${(inst.goalDurationMs/3600000).toFixed(2)}h`);
        }
        if (!inst.isBreached && inst.actualElapsedMs >= inst.goalDurationMs) {
          issues.falseNegativeBreach.push(`${row.key} [${inst.deptName}] elapsed=${(inst.actualElapsedMs/3600000).toFixed(2)}h goal=${(inst.goalDurationMs/3600000).toFixed(2)}h`);
        }
      }
    }

    if (row.resolvedAt && curDeptKey && deptLog[curDeptKey]?.paused_at) {
      const gapMs = new Date(deptLog[curDeptKey].paused_at).getTime() - new Date(row.resolvedAt).getTime();
      if (gapMs > 10 * 60 * 1000) issues.staleResolvedAt.push(`${row.key} gap=${(gapMs/3600000).toFixed(2)}h`);
    }
  }

  for (const [name, list] of Object.entries(issues)) {
    console.log(`=== ${name}: ${list.length} ===`);
    for (const item of list.slice(0, 10)) console.log(`  ${item}`);
    if (list.length > 10) console.log(`  ... and ${list.length - 10} more`);
    console.log('');
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
