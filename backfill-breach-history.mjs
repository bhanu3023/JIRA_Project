// Inserts a "SLA breached — <dept>" issue_history row (field='sla', same
// label format the live monitor already uses for newly-breaching tickets --
// see runMonitorAgentScan's justBreached logic) at the exact reconstructed
// moment, for every already-resolved, breached SLA instance where that
// moment can be confidently reconstructed from real 'sla' history events.
// Purely additive: only INSERTs a new row, never updates or deletes
// anything. Skips (does not guess) any instance that doesn't reconstruct
// confidently (no sla history at all, an unclosed final visit, or a
// reconstructed total that disagrees with dept_sla_log's own authoritative
// elapsed_ms by more than 10 seconds) -- see check-breach-moment-
// reconstruction.mjs for the read-only version of this same logic.
//
// Usage: node backfill-breach-history.mjs
import pg from 'pg';

function rid() {
  return 'bk_' + Math.random().toString(36).slice(2, 14);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const CONFIDENCE_TOLERANCE_MS = 10_000;

function reconstructBreachMoment(historyRows, deptName, goalDurationMs) {
  const startRe = new RegExp(`^SLA (started|resumed) — ${deptName}$`);
  const endRe = new RegExp(`^SLA (paused|resolved) — ${deptName}$`);
  const visits = [];
  let openStart = null;
  for (const h of historyRows) {
    const val = h.newValue || '';
    if (startRe.test(val)) {
      if (openStart) continue;
      openStart = h.createdAt;
    } else if (endRe.test(val)) {
      if (!openStart) continue;
      visits.push({ start: openStart, end: h.createdAt });
      openStart = null;
    }
  }
  if (openStart || !visits.length) return { ok: false };

  let cumulative = 0;
  let reconstructedTotalMs = 0;
  for (const v of visits) reconstructedTotalMs += v.end.getTime() - v.start.getTime();

  for (const v of visits) {
    const visitMs = v.end.getTime() - v.start.getTime();
    if (cumulative + visitMs >= goalDurationMs) {
      return { ok: true, breachAt: new Date(v.start.getTime() + (goalDurationMs - cumulative)), reconstructedTotalMs };
    }
    cumulative += visitMs;
  }
  return { ok: false };
}

async function main() {
  const { rows } = await pool.query(`
    SELECT id, COALESCE(cf_key, key) AS key, sla_snapshot, dept_sla_log
    FROM issues
    WHERE sla_snapshot IS NOT NULL AND jsonb_array_length(sla_snapshot) > 0
  `);

  const breachedEntries = [];
  for (const row of rows) {
    for (const inst of row.sla_snapshot || []) {
      if (inst.isCompleted && inst.isBreached && !inst.waived) {
        breachedEntries.push({ issueId: row.id, key: row.key, deptName: inst.deptName, goalDurationMs: inst.goalDurationMs, deptSlaLog: row.dept_sla_log });
      }
    }
  }
  console.log(`Checking ${breachedEntries.length} breached (non-waived, completed) SLA instances.\n`);

  let inserted = 0, alreadyHad = 0, notConfident = 0;
  const samples = [];

  for (const e of breachedEntries) {
    const label = `SLA breached — ${e.deptName}`;
    const existing = await pool.query(
      `SELECT 1 FROM issue_history WHERE "issueId" = $1 AND field = 'sla' AND "newValue" = $2 LIMIT 1`,
      [e.issueId, label]
    );
    if (existing.rows.length) { alreadyHad++; continue; }

    const { rows: history } = await pool.query(
      `SELECT "newValue", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'sla' ORDER BY "createdAt" ASC`,
      [e.issueId]
    );
    const result = reconstructBreachMoment(history, e.deptName, e.goalDurationMs);
    if (!result.ok) { notConfident++; continue; }

    const deptLogKey = Object.keys(e.deptSlaLog || {}).find((k) => k.toLowerCase() === (e.deptName || '').toLowerCase());
    const authoritativeElapsed = deptLogKey ? e.deptSlaLog[deptLogKey]?.elapsed_ms : null;
    if (authoritativeElapsed == null || Math.abs(result.reconstructedTotalMs - authoritativeElapsed) > CONFIDENCE_TOLERANCE_MS) {
      notConfident++;
      continue;
    }

    await pool.query(
      `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "createdAt") VALUES ($1,$2,'sla',NULL,$3,'System',$4)`,
      [rid(), e.issueId, label, result.breachAt]
    );
    inserted++;
    if (samples.length < 20) samples.push({ key: e.key, dept: e.deptName, breachAt: result.breachAt.toISOString() });
  }

  console.log('=== Sample of inserted breach history entries ===');
  for (const s of samples) console.log(`  ${s.key} [${s.dept}]: ${s.breachAt}`);

  console.log(`\nInserted: ${inserted}`);
  console.log(`Already had this entry: ${alreadyHad}`);
  console.log(`Could not confidently reconstruct (skipped, no guess made): ${notConfident}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
