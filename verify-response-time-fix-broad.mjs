// User wants broad confirmation, not just the one CF-33265 example. Re-runs
// the same 500-ticket sample check-mbr-response-time-zero.mjs used (which
// found 62 "near-zero" cases before the fix), but now computes with the
// FIXED nearest-second rounding (matching the deployed
// computeResponseTimeHours) instead of the old nearest-0.1h rounding, and
// reports how many genuinely still round to exactly 0.0 (should only be
// true same-millisecond cases, essentially none) vs how many now correctly
// show their real sub-6-minute value.
//
// Read-only.
//
// Usage: node verify-response-time-fix-broad.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const IN_PROGRESS_NAMES = new Set(['in progress', 'work in progress']);

// Mirrors the OLD (pre-fix) rounding, for comparison.
function oldCompute(statusHist, deptStartedAt) {
  if (!deptStartedAt) return null;
  const startMs = new Date(deptStartedAt).getTime();
  for (const h of statusHist) {
    if (!IN_PROGRESS_NAMES.has(String(h.newValue || '').trim().toLowerCase())) continue;
    const t = new Date(h.createdAt).getTime();
    if (t < startMs) continue;
    return Math.round(((t - startMs) / 3_600_000) * 10) / 10;
  }
  return null;
}

// Mirrors the NEW (deployed) rounding.
function newCompute(statusHist, deptStartedAt) {
  if (!deptStartedAt) return null;
  const startMs = new Date(deptStartedAt).getTime();
  for (const h of statusHist) {
    if (!IN_PROGRESS_NAMES.has(String(h.newValue || '').trim().toLowerCase())) continue;
    const t = new Date(h.createdAt).getTime();
    if (t < startMs) continue;
    return Math.round((t - startMs) / 1000) / 3600;
  }
  return null;
}

async function main() {
  const { rows: issues } = await pool.query(
    `SELECT id, cf_key, key, current_department, dept_sla_started_at
     FROM issues WHERE dept_sla_started_at IS NOT NULL
     ORDER BY "updatedAt" DESC LIMIT 2000`
  );

  let checked = 0;
  let oldZero = 0, newZero = 0;
  let fixedCount = 0; // old said 0.0, new says a real nonzero value
  let stillZeroButShouldnt = []; // new still says exactly 0 despite a real nonzero gap -- would indicate a remaining bug

  for (const issue of issues) {
    const { rows: hist } = await pool.query(
      `SELECT "oldValue", "newValue", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'status' ORDER BY "createdAt" ASC`,
      [issue.id]
    );
    if (!hist.length) continue;
    const oldVal = oldCompute(hist, issue.dept_sla_started_at);
    const newVal = newCompute(hist, issue.dept_sla_started_at);
    if (oldVal === null) continue;
    checked++;
    if (oldVal === 0) oldZero++;
    if (newVal === 0) {
      newZero++;
      if (oldVal === 0) {
        // Find the real raw diff to see if it's a TRUE zero (same instant) or something the new rounding still missed.
        const startMs = new Date(issue.dept_sla_started_at).getTime();
        const match = hist.find(h => IN_PROGRESS_NAMES.has(String(h.newValue||'').trim().toLowerCase()) && new Date(h.createdAt).getTime() >= startMs);
        const rawDiffMs = match ? new Date(match.createdAt).getTime() - startMs : null;
        if (rawDiffMs !== null && rawDiffMs > 500) stillZeroButShouldnt.push({ key: issue.cf_key || issue.key, rawDiffMs });
      }
    }
    if (oldVal === 0 && newVal !== null && newVal > 0) fixedCount++;
  }

  console.log(`Checked ${checked} tickets with real status history + dept_sla_started_at.`);
  console.log(`Old rounding (0.1h grain): ${oldZero} showed exactly 0.0`);
  console.log(`New rounding (1s grain):   ${newZero} show exactly 0.0`);
  console.log(`Of the old zeros, ${fixedCount} now correctly show their real nonzero sub-6-minute value.`);
  console.log(`Remaining cases where new rounding STILL shows 0 despite a >500ms real gap (should be empty): ${stillZeroButShouldnt.length}`);
  for (const c of stillZeroButShouldnt.slice(0, 10)) console.log(`  ${c.key}: raw diff = ${c.rawDiffMs}ms`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
