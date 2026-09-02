/**
 * fix-sla-elapsed.mjs
 *
 * One-time repair for a bug in pauseDeptSLA (fixed in src/lib/jira-pg-api.ts,
 * commit "Fix false SLA breaches caused by double-counting idle time after
 * resolve"): pausing a department's SLA clock a second time while it was
 * ALREADY paused (e.g. a ticket resolved, sat untouched for days, then got
 * transferred to another department) re-measured elapsed time against a
 * stale dept_sla_started_at timestamp and added the entire idle gap on top
 * of the already-correct elapsed total -- as if the ticket had been actively
 * worked the whole time it sat resolved.
 *
 * This script recomputes the TRUE elapsed time per department per ticket by
 * replaying that ticket's own immutable 'sla' issue_history log (the exact
 * sequence of started/resumed/paused/resolved events already recorded),
 * rather than guessing or capping the corrupted value. A dept's clock only
 * accumulates elapsed time between a start/resume event and the NEXT
 * pause/resolve event for that same dept -- exactly what pauseDeptSLA should
 * have been computing all along.
 *
 * Usage:
 *   DATABASE_URL="..." node fix-sla-elapsed.mjs           # dry run (default) -- prints every change, writes nothing
 *   DATABASE_URL="..." node fix-sla-elapsed.mjs --apply   # actually writes the corrected dept_sla_log
 */
import pg from 'pg';
const { Pool } = pg;

const APPLY = process.argv.includes('--apply');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:neutara123@localhost:5433/neutara_db'
});

function parseSlaEvent(newValue) {
  // e.g. "SLA started — Dev", "SLA resumed — Migration", "SLA paused — QA",
  // "SLA resolved — Infra", "SLA breached — Dev"
  const m = /^SLA (started|resumed|paused|resolved|breached)\s*—\s*(.+)$/.exec((newValue || '').trim());
  if (!m) return null;
  return { action: m[1], dept: m[2].trim() };
}

// Replay one ticket's full sla-history event list into { deptName: elapsedMs }.
function recomputeElapsed(events, now) {
  const runningSince = {};   // dept -> Date | null
  const elapsed = {};        // dept -> ms
  for (const ev of events) {
    const parsed = parseSlaEvent(ev.newValue);
    if (!parsed) continue;
    const { action, dept } = parsed;
    if (!(dept in elapsed)) { elapsed[dept] = 0; runningSince[dept] = null; }
    const ts = new Date(ev.createdAt);
    if (action === 'started' || action === 'resumed') {
      if (!runningSince[dept]) runningSince[dept] = ts;
    } else if (action === 'paused' || action === 'resolved') {
      if (runningSince[dept]) {
        elapsed[dept] += ts.getTime() - runningSince[dept].getTime();
        runningSince[dept] = null;
      }
      // else: already paused -- exactly the bug this script exists to undo.
      // A second pause/resolve event with no intervening start/resume adds nothing.
    }
    // 'breached' is a marker only, not a state transition -- ignored here.
  }
  // Any dept still "running" as of the last event: credit it up to now.
  for (const dept of Object.keys(runningSince)) {
    if (runningSince[dept]) {
      elapsed[dept] += now.getTime() - runningSince[dept].getTime();
    }
  }
  return { elapsed, stillRunning: Object.fromEntries(Object.entries(runningSince).map(([d, v]) => [d, !!v])) };
}

const now = new Date();

const affected = await pool.query(`
  SELECT id, key, cf_key, dept_sla_log
  FROM issues
  WHERE dept_sla_log IS NOT NULL AND dept_sla_log::text != '{}'
    AND EXISTS (
      SELECT 1 FROM jsonb_each(dept_sla_log) AS t(k, v)
      WHERE (v->>'elapsed_ms')::bigint > 86400000
    )
`);

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${affected.rows.length} ticket(s) to check\n`);

let changedCount = 0;

for (const row of affected.rows) {
  const historyRes = await pool.query(
    `SELECT "newValue", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'sla' ORDER BY "createdAt" ASC`,
    [row.id]
  );
  const { elapsed, stillRunning } = recomputeElapsed(historyRes.rows, now);

  const currentLog = row.dept_sla_log || {};
  const newLog = { ...currentLog };
  let ticketChanged = false;

  for (const [dept, newElapsedMs] of Object.entries(elapsed)) {
    // Match the existing log entry case-insensitively (dept names can differ
    // in casing between the history log and the log map keys).
    const existingKey = Object.keys(currentLog).find(k => k.toLowerCase() === dept.toLowerCase()) || dept;
    const existingEntry = currentLog[existingKey] || {};
    const oldElapsedMs = existingEntry.elapsed_ms ?? 0;
    if (Math.abs(oldElapsedMs - newElapsedMs) < 1000) continue; // within 1s — not worth touching

    ticketChanged = true;
    const oldH = (oldElapsedMs / 3600000).toFixed(1);
    const newH = (newElapsedMs / 3600000).toFixed(1);
    console.log(`${row.cf_key ?? row.key}  [${existingKey}]  ${oldH}h -> ${newH}h`);

    newLog[existingKey] = {
      ...existingEntry,
      elapsed_ms: Math.max(0, Math.round(newElapsedMs)),
      status: stillRunning[dept] ? 'running' : 'paused',
    };
  }

  if (ticketChanged) {
    changedCount++;
    if (APPLY) {
      await pool.query(`UPDATE issues SET dept_sla_log = $1::jsonb WHERE id = $2`, [JSON.stringify(newLog), row.id]);
    }
  }
}

console.log(`\n${APPLY ? 'Updated' : 'Would update'} ${changedCount} of ${affected.rows.length} ticket(s).`);
if (!APPLY) console.log('Dry run only -- nothing written. Re-run with --apply to write these changes.');

await pool.end();
