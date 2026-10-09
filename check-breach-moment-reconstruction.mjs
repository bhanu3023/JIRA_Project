// Reconstructs the EXACT moment a resolved, breached ticket's department
// crossed its SLA goal, from real issue_history 'sla' events (SLA started/
// resumed = visit start, SLA paused/resolved = visit end), walking visits in
// order and summing elapsed time until the cumulative total crosses
// goalDurationMs. This is what would get inserted as a "SLA breached — X"
// history entry (matching the live monitor's own existing label format,
// logSlaHistory) at that calculated timestamp -- the same thing Jira shows
// in its own activity log. Read-only: only REPORTS the computed moment and a
// confidence check (reconstructed total vs dept_sla_log's own authoritative
// elapsed_ms), does not write anything yet.
//
// Usage: node check-breach-moment-reconstruction.mjs [limit]
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const LIMIT = parseInt(process.argv[2] || '25', 10);

function reconstructBreachMoment(historyRows, deptName, goalDurationMs) {
  const startRe = new RegExp(`^SLA (started|resumed) — ${deptName}$`);
  const endRe = new RegExp(`^SLA (paused|resolved) — ${deptName}$`);
  const visits = [];
  let openStart = null;
  for (const h of historyRows) {
    const val = h.newValue || '';
    if (startRe.test(val)) {
      if (openStart) continue; // already open, ignore duplicate start
      openStart = h.createdAt;
    } else if (endRe.test(val)) {
      if (!openStart) continue; // end with no matching start, ignore
      visits.push({ start: openStart, end: h.createdAt });
      openStart = null;
    }
  }
  if (openStart) return { ok: false, reason: 'unclosed final visit (no paused/resolved event found)' };
  if (!visits.length) return { ok: false, reason: 'no visits reconstructed at all' };

  let cumulative = 0;
  let reconstructedTotalMs = 0;
  for (const v of visits) reconstructedTotalMs += v.end.getTime() - v.start.getTime();

  for (const v of visits) {
    const visitMs = v.end.getTime() - v.start.getTime();
    if (cumulative + visitMs >= goalDurationMs) {
      const breachAt = new Date(v.start.getTime() + (goalDurationMs - cumulative));
      return { ok: true, breachAt, reconstructedTotalMs, visitsCount: visits.length };
    }
    cumulative += visitMs;
  }
  return { ok: false, reason: 'cumulative never reached goalDurationMs (reconstructed total < goal)', reconstructedTotalMs };
}

async function main() {
  const { rows } = await pool.query(`
    SELECT id, COALESCE(cf_key, key) AS key, sla_snapshot, dept_sla_log
    FROM issues
    WHERE sla_snapshot IS NOT NULL AND jsonb_array_length(sla_snapshot) > 0
    LIMIT 5000
  `);

  const breachedEntries = [];
  for (const row of rows) {
    for (const inst of row.sla_snapshot || []) {
      if (inst.isCompleted && inst.isBreached && !inst.waived) {
        breachedEntries.push({ issueId: row.id, key: row.key, deptName: inst.deptName, goalDurationMs: inst.goalDurationMs, deptSlaLog: row.dept_sla_log });
      }
    }
  }
  console.log(`Found ${breachedEntries.length} breached (non-waived, completed) SLA instances across ${rows.length} resolved tickets.\n`);

  const toCheck = breachedEntries.slice(0, LIMIT);
  let okCount = 0, failCount = 0;
  for (const e of toCheck) {
    const { rows: history } = await pool.query(
      `SELECT "newValue", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'sla' ORDER BY "createdAt" ASC`,
      [e.issueId]
    );
    const result = reconstructBreachMoment(history, e.deptName, e.goalDurationMs);
    const deptLogKey = Object.keys(e.deptSlaLog || {}).find((k) => k.toLowerCase() === (e.deptName || '').toLowerCase());
    const authoritativeElapsed = deptLogKey ? e.deptSlaLog[deptLogKey]?.elapsed_ms : null;
    if (result.ok) {
      const diffMs = authoritativeElapsed != null ? Math.abs(result.reconstructedTotalMs - authoritativeElapsed) : null;
      const confident = diffMs != null && diffMs < 5000; // within 5 seconds
      console.log(`${e.key} [${e.deptName}]: breachAt=${result.breachAt.toISOString()} visits=${result.visitsCount} reconstructed=${(result.reconstructedTotalMs/3600000).toFixed(2)}h authoritative=${authoritativeElapsed != null ? (authoritativeElapsed/3600000).toFixed(2)+'h' : 'n/a'} diff=${diffMs}ms confident=${confident}`);
      if (confident) okCount++; else failCount++;
    } else {
      console.log(`${e.key} [${e.deptName}]: FAILED -- ${result.reason}`);
      failCount++;
    }
  }
  console.log(`\nConfidently reconstructed: ${okCount} / ${toCheck.length} checked (${breachedEntries.length} total breached instances exist)`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
