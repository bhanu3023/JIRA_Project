// Backfill for the 39 already-affected false-resolved-dept tickets: the
// forward fix (performDeptHandoff now pauses a department's clock the
// instant it arrives already-resolved) only prevents NEW occurrences --
// these tickets are already stuck with dept_sla_log[currentDept].status =
// "running", paused_at: null, indefinitely. Mirrors exactly what the new
// code does for a fresh handoff: pauses the clock with essentially zero
// additional elapsed time added (this department never did any real work
// on an already-resolved ticket, so it should accrue none), then clears
// sla_snapshot so everything recomputes cleanly and consistently.
//
// Usage: node backfill-pause-stuck-dept-clocks.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT id, COALESCE(cf_key, key) AS key, current_department, dept_sla_log, sla_snapshot
    FROM issues
    WHERE sla_snapshot IS NOT NULL AND jsonb_array_length(sla_snapshot) > 0
  `);

  const toFix = [];
  for (const row of rows) {
    const deptLog = row.dept_sla_log || {};
    const curDept = (row.current_department || '').trim().toLowerCase();
    const curDeptKey = Object.keys(deptLog).find((k) => k.toLowerCase() === curDept);
    const isCurrentDeptInstanceCompleted = (row.sla_snapshot || []).some(
      (inst) => (inst.deptName || '').trim().toLowerCase() === curDept && inst.isCompleted
    );
    if (isCurrentDeptInstanceCompleted && curDeptKey && deptLog[curDeptKey]?.status === 'running') {
      toFix.push({ row, curDeptKey });
    }
  }

  console.log(`Found ${toFix.length} tickets with a stuck "running" department clock.\n`);

  for (const { row, curDeptKey } of toFix) {
    const deptLog = { ...(row.dept_sla_log || {}) };
    const entry = deptLog[curDeptKey];
    const nowIso = new Date().toISOString();
    deptLog[curDeptKey] = { ...entry, status: 'paused', paused_at: nowIso };
    await pool.query(
      `UPDATE issues SET dept_sla_log = $1::jsonb, sla_snapshot = NULL WHERE id = $2`,
      [JSON.stringify(deptLog), row.id]
    );
    console.log(`  Fixed: ${row.key} [${curDeptKey}] -- paused, elapsed_ms unchanged (${entry.elapsed_ms})`);
  }

  console.log(`\nFixed: ${toFix.length}. Each will recompute fresh (consistently) the next time it's viewed.`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
