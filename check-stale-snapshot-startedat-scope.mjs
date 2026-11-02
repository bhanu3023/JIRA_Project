// Read-only: for every resolved ticket, check whether its frozen
// sla_snapshot entry for its OWN CURRENT department has a startedAt that
// matches dept_sla_log[current_department].started_at (the authoritative,
// correctly-maintained record of when that department's final stint began).
// A mismatch means the snapshot was frozen with a stale startedAt --
// affecting the displayed Start/Due and "Actively worked" figures (NOT the
// breach verdict itself, which uses actualElapsedMs, already independently
// verified correct).
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, COALESCE(i.cf_key,i.key) AS key, i.current_department, i.dept_sla_log, i.sla_snapshot
    FROM issues i
    WHERE i."resolvedAt" IS NOT NULL AND i.sla_snapshot IS NOT NULL
      AND jsonb_array_length(i.sla_snapshot) > 0 AND i.current_department IS NOT NULL
  `);

  let checked = 0, mismatched = 0;
  const examples = [];
  for (const r of rows) {
    const dept = (r.current_department || '').toLowerCase();
    const snapEntry = (r.sla_snapshot || []).find((x) => (x.deptName || '').toLowerCase() === dept);
    if (!snapEntry) continue;
    const deptLogKey = Object.keys(r.dept_sla_log || {}).find((k) => k.toLowerCase() === dept);
    const logEntry = deptLogKey ? r.dept_sla_log[deptLogKey] : null;
    if (!logEntry?.started_at) continue;
    checked++;
    const snapStart = new Date(snapEntry.startedAt).getTime();
    const logStart = new Date(logEntry.started_at).getTime();
    if (Math.abs(snapStart - logStart) > 60000) { // more than 1 minute apart
      mismatched++;
      if (examples.length < 20) {
        examples.push(`${r.key}: snapshot.startedAt=${snapEntry.startedAt} vs dept_sla_log.started_at=${logEntry.started_at} (gap=${((logStart-snapStart)/3600000).toFixed(1)}h)`);
      }
    }
  }

  console.log(`Resolved tickets checked (have both a snapshot entry and a dept_sla_log entry for their current dept): ${checked}`);
  console.log(`Mismatched (snapshot startedAt stale by more than 1 minute): ${mismatched}`);
  console.log('\nExamples:');
  for (const e of examples) console.log(' - ' + e);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
