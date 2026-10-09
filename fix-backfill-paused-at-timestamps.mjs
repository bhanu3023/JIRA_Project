// Corrects a cosmetic side-effect of backfill-pause-stuck-dept-clocks.mjs:
// it paused each stuck department's clock at "now" (whenever that script
// ran), which is honest about WHEN the fix was applied but creates a huge,
// misleading gap against each ticket's real (much older) resolvedAt --
// exactly the pattern check-sla-system-health.mjs's staleResolvedAt check
// (and backfill-stale-resolvedat.mjs's own detection logic) looks for. If
// that resolvedAt-correction script is ever re-run, it would misread these
// 39 tickets as having a stale resolvedAt and incorrectly bump it to
// today's date. Re-points dept_sla_log[currentDept].paused_at to each
// ticket's own resolvedAt instead -- a far more historically honest value
// for "when this department's involvement with an already-done ticket
// ended" -- for exactly the 39 tickets backfill-pause-stuck-dept-
// clocks.mjs touched. elapsed_ms (the real tracked time, already correct)
// is left completely untouched; only paused_at and status move the clock
// into a non-"running" resting state honestly.
//
// Usage: node fix-backfill-paused-at-timestamps.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT id, COALESCE(cf_key, key) AS key, current_department, "resolvedAt", dept_sla_log
    FROM issues
    WHERE "resolvedAt" IS NOT NULL AND dept_sla_log IS NOT NULL
  `);

  let fixed = 0;
  for (const row of rows) {
    const deptLog = row.dept_sla_log || {};
    const curDept = (row.current_department || '').trim().toLowerCase();
    const curDeptKey = Object.keys(deptLog).find((k) => k.toLowerCase() === curDept);
    if (!curDeptKey) continue;
    const entry = deptLog[curDeptKey];
    if (entry?.status !== 'paused' || !entry?.paused_at) continue;

    const resolvedMs = new Date(row.resolvedAt).getTime();
    const pausedMs = new Date(entry.paused_at).getTime();
    const gapMs = pausedMs - resolvedMs;
    // Only touch the specific signature this correction targets: paused_at
    // suspiciously recent (within the last day, i.e. "now" from whenever a
    // backfill script ran) while resolvedAt is much older -- not a general
    // resolvedAt-staleness sweep, which is a separate, already-handled case.
    if (gapMs <= 24 * 3600_000) continue; // paused_at isn't suspiciously recent
    const pausedRecently = Date.now() - pausedMs < 24 * 3600_000;
    if (!pausedRecently) continue;

    const newDeptLog = { ...deptLog, [curDeptKey]: { ...entry, paused_at: row.resolvedAt.toISOString() } };
    await pool.query(`UPDATE issues SET dept_sla_log = $1::jsonb WHERE id = $2`, [JSON.stringify(newDeptLog), row.id]);
    fixed++;
    console.log(`  ${row.key} [${curDeptKey}]: paused_at -> ${row.resolvedAt.toISOString()} (was ${entry.paused_at})`);
  }

  console.log(`\nFixed: ${fixed}`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
