// Backfill for the actualElapsedMs display fix: every already-resolved
// ticket's sla_snapshot is frozen, so the fix only applies to NEWLY
// resolved tickets (or one re-frozen after a snapshot clear) going forward.
// This adds actualElapsedMs directly to each already-frozen, completed
// snapshot entry, using dept_sla_log[entry.deptName].elapsed_ms -- the same
// real cumulative-time value the backend's own isBreached check already
// uses, just not previously exposed to the frontend. Pure, deterministic,
// mechanical: does not touch isBreached, waived, dueTime, startedAt, or any
// other field.
//
// Usage: node backfill-actual-elapsed-ms.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT id, key, dept_sla_log, sla_snapshot FROM issues
    WHERE sla_snapshot IS NOT NULL AND jsonb_array_length(sla_snapshot) > 0
      AND dept_sla_log IS NOT NULL
  `);
  console.log(`Found ${rows.length} resolved tickets with both sla_snapshot and dept_sla_log.\n`);

  let changed = 0;
  let unchanged = 0;
  const samples = [];

  for (const row of rows) {
    const deptLog = row.dept_sla_log || {};
    const snapshot = row.sla_snapshot || [];
    let rowChanged = false;
    const newSnapshot = snapshot.map((inst) => {
      if (typeof inst.actualElapsedMs === 'number') return inst; // already has it
      const deptKey = Object.keys(deptLog).find((k) => k.toLowerCase() === (inst.deptName || '').trim().toLowerCase());
      if (!deptKey) return inst; // no matching dept_sla_log entry -- leave untouched
      const elapsed = deptLog[deptKey]?.elapsed_ms;
      if (typeof elapsed !== 'number') return inst;
      rowChanged = true;
      if (samples.length < 15) samples.push({ key: row.key, dept: inst.deptName, elapsed });
      return { ...inst, actualElapsedMs: elapsed };
    });

    if (rowChanged) {
      await pool.query(`UPDATE issues SET sla_snapshot = $1::jsonb WHERE id = $2`, [JSON.stringify(newSnapshot), row.id]);
      changed++;
    } else {
      unchanged++;
    }
  }

  console.log(`=== Sample of backfilled tickets ===`);
  for (const s of samples) console.log(`  ${s.key} [${s.dept}]: actualElapsedMs=${s.elapsed} (${(s.elapsed / 3600000).toFixed(2)}h)`);

  console.log(`\nChanged: ${changed}`);
  console.log(`Unchanged (already had it, or no matching dept_sla_log entry): ${unchanged}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
