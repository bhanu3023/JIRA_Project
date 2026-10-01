// The SLA-freeze fix froze ~90 resolved tickets' sla_snapshot using
// whatever sla_definitions said at view-time -- before the historical-
// override fix (Migration Medium=10h, Dev all tiers per its own now-
// inactive policy row) went in. Any of those ~90 that are Migration or Dev
// department, resolved, with a dept-SLA period that started before that
// department's Sep 28 2026 policy edit, were frozen using the WRONG (new)
// target. Clearing their sla_snapshot so the next view (or the bulk
// backfill) recomputes them with the override now in place -- never
// touches a snapshot outside this narrow, confirmed-affected set.
//
// Dry-run by default. Pass --apply to actually clear.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

const CUTOFFS = {
  migration: Date.parse('2026-09-28T10:57:56.000Z'),
  dev: Date.parse('2026-09-28T10:57:19.000Z'),
};

async function main() {
  const { rows } = await pool.query(
    `SELECT id, key, cf_key, priority, current_department, dept_sla_started_at,
            dept_sla_log, "createdAt", sla_snapshot
     FROM issues
     WHERE sla_snapshot IS NOT NULL`
  );
  console.log(`Checking ${rows.length} already-frozen tickets...`);

  const toClear = [];
  for (const t of rows) {
    // Check current department's own period
    const dept = (t.current_department || '').trim().toLowerCase();
    const cutoff = CUTOFFS[dept];
    if (cutoff) {
      const startMs = t.dept_sla_started_at ? new Date(t.dept_sla_started_at).getTime() : new Date(t.createdAt).getTime();
      if (startMs < cutoff) { toClear.push(t); continue; }
    }
    // Check any historical (past-department) periods logged for Migration/Dev
    const deptSlaLog = t.dept_sla_log || {};
    let matched = false;
    for (const histDeptKey of Object.keys(deptSlaLog)) {
      const histDeptLower = histDeptKey.trim().toLowerCase();
      const histCutoff = CUTOFFS[histDeptLower];
      if (!histCutoff) continue;
      const histEntry = deptSlaLog[histDeptKey];
      const histStart = histEntry?.started_at ? new Date(histEntry.started_at).getTime() : new Date(t.createdAt).getTime();
      if (histStart < histCutoff) { matched = true; break; }
    }
    if (matched) toClear.push(t);
  }

  console.log(`\n${toClear.length} tickets affected (frozen under the old/wrong target):`);
  for (const t of toClear) {
    console.log(`  ${t.key || t.cf_key} — dept=${t.current_department}, priority=${t.priority}`);
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to clear these snapshots.');
    await pool.end();
    return;
  }

  for (const t of toClear) {
    await pool.query(`UPDATE issues SET sla_snapshot = NULL WHERE id = $1`, [t.id]);
  }
  console.log(`\nCleared ${toClear.length} snapshots. They'll recompute correctly on next view or the bulk backfill.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
