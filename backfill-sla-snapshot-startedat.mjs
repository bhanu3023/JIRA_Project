// Applies the same startedAt-consistency fix from jira-pg-api.ts
// directly to already-frozen sla_snapshot columns, since the issue
// detail endpoint returns that stored column verbatim for resolved
// tickets rather than recomputing live -- the code fix alone only
// helps NEWLY-resolved tickets going forward.
//
// For each completed (isCompleted=true, resolvedAt set) entry in
// sla_snapshot, recomputes startedAt = resolvedAt - dept_sla_log
// [deptName].elapsed_ms -- the exact same formula the live code now
// uses, verified to reproduce the identical dueTime relationship
// (startedAt + goalDurationMs === dueTime). Only touches entries
// where the recomputed value actually differs (idempotent/safe to
// re-run). Dry-run by default; --apply to write.
//
// Usage: node backfill-sla-snapshot-startedat.mjs [--apply] [--limit N]
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(a => a.startsWith('--limit'));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1] || process.argv[process.argv.indexOf(limitArg) + 1], 10) : null;

async function main() {
  const { rows } = await pool.query(`
    SELECT id, COALESCE(cf_key, key) AS key, sla_snapshot, dept_sla_log
    FROM issues
    WHERE sla_snapshot IS NOT NULL AND jsonb_array_length(sla_snapshot) > 0
    ${LIMIT ? `LIMIT ${LIMIT}` : ''}
  `);
  console.log(`${rows.length} tickets have a non-empty sla_snapshot.`);

  let checked = 0, changed = 0, applied = 0;
  for (const row of rows) {
    const snapshot = row.sla_snapshot;
    const deptLog = row.dept_sla_log || {};
    let rowChanged = false;
    for (const entry of snapshot) {
      if (!entry.isCompleted || !entry.resolvedAt) continue;
      checked++;
      const deptKey = Object.keys(deptLog).find(k => k.toLowerCase() === String(entry.deptName || '').toLowerCase());
      const elapsedMs = deptKey ? deptLog[deptKey]?.elapsed_ms : null;
      if (elapsedMs == null) continue;
      const correctStartedAt = new Date(new Date(entry.resolvedAt).getTime() - elapsedMs).toISOString();
      if (correctStartedAt !== entry.startedAt) {
        changed++;
        entry.startedAt = correctStartedAt;
        rowChanged = true;
      }
    }
    if (rowChanged && APPLY) {
      await pool.query(`UPDATE issues SET sla_snapshot = $1::jsonb WHERE id = $2`, [JSON.stringify(snapshot), row.id]);
      applied++;
    } else if (rowChanged && changed <= 10) {
      console.log(`  would fix ${row.key}`);
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`tickets scanned=${rows.length} completed-entries checked=${checked} entries needing fix=${changed}`);
  console.log(APPLY ? `Applied: updated sla_snapshot on ${applied} tickets.` : 'Dry run only -- re-run with --apply to write.');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
