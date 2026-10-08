// Quantifies how many tickets show the same bug confirmed on CF-29905:
// a frozen SLA snapshot whose Start/Due dates are computed backward from
// issue.resolvedAt, where resolvedAt is stale (never re-stamped on a
// ticket's real, final resolution after being reopened once already).
// Two independent, unambiguous signals, checked separately:
//   (A) snapshot startedAt < issue.createdAt -- impossible for a real
//       ticket, proves the backward-computed Start predates the ticket's
//       own existence (exactly CF-29905's symptom).
//   (B) dept_sla_log[current_department].paused_at is clearly AFTER
//       issue.resolvedAt (by more than an hour, to avoid flagging normal
//       rounding/race noise) -- the department's own SLA clock kept
//       running well past the moment resolvedAt claims the ticket was
//       done, meaning resolvedAt wasn't re-stamped at the real final
//       resolution.
// Read-only. Reports counts + a sample of affected keys for each signal.
//
// Usage: node check-sla-stale-resolved-at.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.key, i."createdAt", i."resolvedAt", i.current_department, i.dept_sla_log, i.sla_snapshot
    FROM issues i
    WHERE i.sla_snapshot IS NOT NULL
      AND jsonb_array_length(i.sla_snapshot) > 0
  `);
  console.log(`Total resolved tickets with a frozen sla_snapshot: ${rows.length}\n`);

  const signalA = []; // startedAt before createdAt
  const signalB = []; // dept clock paused well after resolvedAt

  for (const row of rows) {
    const createdMs = new Date(row.createdAt).getTime();
    const snapshot = row.sla_snapshot || [];
    for (const inst of snapshot) {
      if (inst.startedAt && new Date(inst.startedAt).getTime() < createdMs) {
        signalA.push({ key: row.key, policy: inst.policyName, dept: inst.deptName, startedAt: inst.startedAt, createdAt: row.createdAt });
        break;
      }
    }

    const resolvedMs = row.resolvedAt ? new Date(row.resolvedAt).getTime() : null;
    const deptLog = row.dept_sla_log || {};
    const curDeptKey = Object.keys(deptLog).find((k) => k.toLowerCase() === (row.current_department || '').trim().toLowerCase());
    if (resolvedMs && curDeptKey && deptLog[curDeptKey]?.paused_at) {
      const pausedMs = new Date(deptLog[curDeptKey].paused_at).getTime();
      if (pausedMs - resolvedMs > 3600_000) {
        signalB.push({ key: row.key, dept: row.current_department, resolvedAt: row.resolvedAt, pausedAt: deptLog[curDeptKey].paused_at, gapHrs: ((pausedMs - resolvedMs) / 3600_000).toFixed(1) });
      }
    }
  }

  console.log(`=== Signal A: frozen Start date predates ticket creation (${signalA.length} tickets) ===`);
  for (const r of signalA.slice(0, 30)) {
    console.log(`  ${r.key} [${r.dept}/${r.policy}] startedAt=${r.startedAt} createdAt=${r.createdAt}`);
  }
  if (signalA.length > 30) console.log(`  ... and ${signalA.length - 30} more`);

  console.log(`\n=== Signal B: dept SLA clock paused >1h after resolvedAt (${signalB.length} tickets) ===`);
  for (const r of signalB.slice(0, 30)) {
    console.log(`  ${r.key} [${r.dept}] resolvedAt=${r.resolvedAt} paused_at=${r.pausedAt} gap=${r.gapHrs}h`);
  }
  if (signalB.length > 30) console.log(`  ... and ${signalB.length - 30} more`);

  const union = new Set([...signalA.map(r => r.key), ...signalB.map(r => r.key)]);
  console.log(`\nTotal distinct affected tickets (A ∪ B): ${union.size}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
