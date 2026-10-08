// Corrects the 27 tickets check-resolvedat-vs-pausedat.mjs found where
// issue.resolvedAt is stale -- confirmed for real on CF-29905: resolved
// once (while in a different department), reopened, handed to its real
// final department, genuinely resolved there again days later, but that
// second resolution never re-stamped resolvedAt (root cause fixed
// separately, forward-only). dept_sla_log[current_department].paused_at is
// a reliable proxy for the true final resolution moment -- it's set by
// pauseDeptSLA at the exact instant that department's own SLA clock
// actually stopped, independent of whether resolvedAt itself got updated.
//
// Only corrects the POSITIVE-gap direction (paused_at clearly AFTER
// resolvedAt, >10min) -- that's the one unambiguous signature of this bug.
// A NEGATIVE gap (paused_at before resolvedAt) is a different, unrelated
// situation (e.g. this department was paused for a handoff, and the ticket
// was genuinely resolved later, elsewhere) and is left untouched.
//
// For each corrected ticket: updates issues.resolvedAt, and rewrites the
// matching resolvedAt field(s) inside the already-frozen sla_snapshot
// (only entries whose stored resolvedAt exactly equals the OLD stale
// value -- i.e. entries that were actually frozen using it; null/other
// values are left alone). isBreached/waived/durationMs/etc are untouched.
//
// Usage: node backfill-stale-resolvedat.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const THRESHOLD_MS = 10 * 60 * 1000;

async function main() {
  const { rows } = await pool.query(`
    SELECT id, key, cf_key, "resolvedAt", current_department, dept_sla_log, sla_snapshot
    FROM issues
    WHERE sla_snapshot IS NOT NULL AND jsonb_array_length(sla_snapshot) > 0
      AND "resolvedAt" IS NOT NULL
  `);

  let corrected = 0;
  for (const row of rows) {
    const deptLog = row.dept_sla_log || {};
    const curDeptKey = Object.keys(deptLog).find((k) => k.toLowerCase() === (row.current_department || '').trim().toLowerCase());
    if (!curDeptKey || !deptLog[curDeptKey]?.paused_at) continue;

    const oldResolvedAtMs = new Date(row.resolvedAt).getTime();
    const oldResolvedIso = new Date(row.resolvedAt).toISOString();
    const pausedMs = new Date(deptLog[curDeptKey].paused_at).getTime();
    const gapMs = pausedMs - oldResolvedAtMs;
    if (gapMs <= THRESHOLD_MS) continue; // only the positive-gap signature

    const newResolvedIso = new Date(pausedMs).toISOString();

    const snapshot = row.sla_snapshot || [];
    const newSnapshot = snapshot.map((inst) => (
      inst.resolvedAt === oldResolvedIso ? { ...inst, resolvedAt: newResolvedIso } : inst
    ));

    await pool.query(
      `UPDATE issues SET "resolvedAt" = $1, sla_snapshot = $2::jsonb WHERE id = $3`,
      [newResolvedIso, JSON.stringify(newSnapshot), row.id]
    );

    corrected++;
    console.log(`${row.cf_key || row.key}: resolvedAt ${oldResolvedIso} -> ${newResolvedIso}  (gap was ${(gapMs / 3600_000).toFixed(1)}h)`);
  }

  console.log(`\nCorrected: ${corrected}`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
