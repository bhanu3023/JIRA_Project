// Read-only: CF-34499 visited Migration MULTIPLE separate times (per its
// department-handoff history), not once. The "Actively worked (In
// Progress)" calc approximates this as ONE continuous window
// [dept_sla_started_at, dept_sla_started_at + actualElapsedMs) -- for a
// ticket with several non-contiguous visits, that window can extend past
// when the ticket actually left the department into a LATER, unrelated
// department's real calendar time, wrongly counting THEIR "In Progress"
// time as Migration's own. Verify precisely whether the displayed 5h54m is
// real, or an artifact of that approximation.
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
  const { rows } = await pool.query(`
    SELECT i.id, i.sla_snapshot FROM issues i WHERE i.cf_key = 'CF-34499' OR i.key = 'CF-34499'
  `);
  const r = rows[0];
  const migSnap = (r.sla_snapshot || []).find((x) => (x.deptName || '').toLowerCase() === 'migration');
  console.log('Migration frozen snapshot entry:', JSON.stringify(migSnap, null, 2));

  const windowStartMs = new Date(migSnap.startedAt).getTime();
  const windowEndMs = windowStartMs + migSnap.actualElapsedMs;
  console.log(`\nApproximated window used for "Actively worked": ${new Date(windowStartMs).toISOString()} -> ${new Date(windowEndMs).toISOString()}`);

  // Real Migration visit windows, from the department-change history.
  const { rows: deptHist } = await pool.query(`
    SELECT "oldValue", "newValue", "createdAt" FROM issue_history
    WHERE "issueId" = $1 AND field = 'department' ORDER BY "createdAt" ASC
  `, [r.id]);
  console.log('\nReal Migration visit windows (from department history):');
  let inMigration = false, visitStart = null;
  for (const h of deptHist) {
    const enteringMigration = h.newValue && h.newValue.toLowerCase().includes('migration');
    const leavingMigration = h.oldValue && h.oldValue.toLowerCase() === 'migration';
    if (enteringMigration && !inMigration) { visitStart = h.createdAt; inMigration = true; }
    if (leavingMigration && inMigration) {
      console.log(`  ${visitStart.toISOString()} -> ${h.createdAt.toISOString()} (${((h.createdAt - visitStart)/3600000).toFixed(2)}h)`);
      inMigration = false;
    }
  }

  const { rows: statusHist } = await pool.query(
    `SELECT "newValue", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'status' ORDER BY "createdAt" ASC`,
    [r.id]
  );
  const computed = computeInProgressMsInWindow(statusHist, windowStartMs, windowEndMs);
  console.log(`\nComputed "Actively worked" using the approximated single window: ${(computed/3600000).toFixed(2)}h (app shows 5h54m = 5.9h)`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
