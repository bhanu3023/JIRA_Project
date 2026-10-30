// Read-only: audit the "Actively worked (In Progress)" field across many
// recently-resolved tickets. Independently re-derives it straight from raw
// issue_history (field='status') for each department instance's window
// [startedAt, startedAt + actualElapsedMs), mirroring
// computeInProgressMsInWindow's own logic, and flags anything implausible
// (negative, exceeds the dept's own total elapsed time, etc.) instead of
// trusting the app's own computation blindly.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function computeInProgressMsInWindow(statusHistory, windowStartMs, windowEndMs) {
  if (!(windowEndMs > windowStartMs)) return 0;
  let total = 0;
  let currentStatus = null;
  let cursor = windowStartMs;
  for (const row of statusHistory) {
    const t = new Date(row.createdAt).getTime();
    if (t <= windowStartMs) { currentStatus = row.newValue; continue; }
    if (t >= windowEndMs) break;
    if ((currentStatus || '').trim().toLowerCase() === 'in progress') total += t - cursor;
    cursor = t;
    currentStatus = row.newValue;
  }
  if ((currentStatus || '').trim().toLowerCase() === 'in progress') total += windowEndMs - cursor;
  return total;
}

async function main() {
  const { rows: issues } = await pool.query(`
    SELECT id, COALESCE(cf_key, key) AS key, sla_snapshot
    FROM issues
    WHERE "resolvedAt" IS NOT NULL AND sla_snapshot IS NOT NULL
      AND jsonb_array_length(sla_snapshot) > 0
    ORDER BY "resolvedAt" DESC
    LIMIT 40
  `);

  let checked = 0, anomalies = 0;
  for (const issue of issues) {
    const { rows: statusHistory } = await pool.query(
      `SELECT "newValue", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'status' ORDER BY "createdAt" ASC`,
      [issue.id]
    );
    for (const inst of issue.sla_snapshot) {
      if (!inst.startedAt || typeof inst.actualElapsedMs !== 'number') continue;
      const startMs = new Date(inst.startedAt).getTime();
      const endMs = startMs + inst.actualElapsedMs;
      const computed = computeInProgressMsInWindow(statusHistory, startMs, endMs);
      checked++;
      const flags = [];
      if (computed < 0) flags.push('NEGATIVE');
      if (computed > inst.actualElapsedMs + 1000) flags.push('EXCEEDS_ELAPSED');
      if (flags.length) {
        anomalies++;
        console.log(`ANOMALY ${issue.key} dept=${inst.deptName || '(space-wide)'}: computed=${computed}ms elapsed=${inst.actualElapsedMs}ms flags=${flags.join(',')}`);
      }
    }
  }
  console.log(`\nChecked ${checked} department instances across ${issues.length} tickets.`);
  console.log(`Anomalies found: ${anomalies}`);

  // Show 5 concrete examples (ticket, dept, computed in-progress time vs
  // total elapsed) so the numbers can be spot-checked against real History.
  console.log('\nSample (first 5 non-trivial instances):');
  let shown = 0;
  for (const issue of issues) {
    if (shown >= 5) break;
    const { rows: statusHistory } = await pool.query(
      `SELECT "newValue", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'status' ORDER BY "createdAt" ASC`,
      [issue.id]
    );
    for (const inst of issue.sla_snapshot) {
      if (shown >= 5) break;
      if (!inst.startedAt || typeof inst.actualElapsedMs !== 'number' || inst.actualElapsedMs < 60000) continue;
      const startMs = new Date(inst.startedAt).getTime();
      const endMs = startMs + inst.actualElapsedMs;
      const computed = computeInProgressMsInWindow(statusHistory, startMs, endMs);
      console.log(` - ${issue.key} dept=${inst.deptName || '(space-wide)'}: elapsed=${(inst.actualElapsedMs/60000).toFixed(1)}min, inProgress=${(computed/60000).toFixed(1)}min`);
      shown++;
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
