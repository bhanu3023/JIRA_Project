// Read-only check before writing a resolvedAt backfill. For every resolved
// ticket, compares issue.resolvedAt against
// dept_sla_log[current_department].paused_at -- the moment pauseDeptSLA
// actually stopped that department's SLA clock, which is a reliable proxy
// for "when this ticket was REALLY, finally resolved" (confirmed on
// CF-29905: paused_at landed right where the real elapsed time -- 6d18h --
// said it should, while resolvedAt stayed frozen at an earlier, non-final
// resolution). Reports how many tickets have a meaningful gap (>5 min)
// between the two, which is exactly the set a resolvedAt backfill would
// need to correct.
//
// Usage: node check-resolvedat-vs-pausedat.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT key, "createdAt", "resolvedAt", current_department, dept_sla_log
    FROM issues
    WHERE sla_snapshot IS NOT NULL AND jsonb_array_length(sla_snapshot) > 0
      AND "resolvedAt" IS NOT NULL
  `);
  console.log(`Checking ${rows.length} resolved tickets.\n`);

  let gapCount = 0;
  const samples = [];
  for (const row of rows) {
    const deptLog = row.dept_sla_log || {};
    const curDeptKey = Object.keys(deptLog).find((k) => k.toLowerCase() === (row.current_department || '').trim().toLowerCase());
    if (!curDeptKey || !deptLog[curDeptKey]?.paused_at) continue;
    const resolvedMs = new Date(row.resolvedAt).getTime();
    const pausedMs = new Date(deptLog[curDeptKey].paused_at).getTime();
    const gapMs = pausedMs - resolvedMs;
    if (Math.abs(gapMs) > 5 * 60 * 1000) {
      gapCount++;
      if (samples.length < 20) {
        samples.push({ key: row.key, dept: row.current_department, resolvedAt: row.resolvedAt, pausedAt: deptLog[curDeptKey].paused_at, gapHrs: (gapMs / 3600_000).toFixed(1) });
      }
    }
  }

  console.log(`=== Sample of tickets where resolvedAt disagrees with dept_sla_log's own paused_at by >5min (${gapCount} total) ===`);
  for (const s of samples) {
    console.log(`  ${s.key} [${s.dept}] resolvedAt=${s.resolvedAt}  paused_at=${s.pausedAt}  gap=${s.gapHrs}h`);
  }
  console.log(`\nTotal tickets needing a resolvedAt correction: ${gapCount}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
