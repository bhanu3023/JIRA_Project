// Read-only: scope how many RESOLVED tickets were affected by the
// millisecond-timestamp-drift bug just fixed in jira-pg-api.ts (isOwnResolution
// requiring exact equality between the issue row's resolvedAt and the
// status-change issue_history row's createdAt, which routinely differ by a
// few ms since they're two separate writes in the same resolve request).
// For every resolved ticket with a frozen sla_snapshot, find its own
// Resolved-status-change history row, and classify:
//   - exact match (0ms drift): never affected
//   - small drift (1ms - 5000ms) AND genuinely not breached: this ticket's
//     History tab was showing a FALSE "SLA Breached" badge before the fix
//   - small drift AND genuinely breached: harmless either way (same verdict)
//   - no matching status row found: skipped
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i.sla_snapshot, i."resolvedAt"
    FROM issues i
    WHERE i."resolvedAt" IS NOT NULL AND i.sla_snapshot IS NOT NULL
      AND jsonb_array_length(i.sla_snapshot) > 0
  `);

  let checked = 0, exactMatch = 0, driftedNotBreached = 0, driftedButBreached = 0, noStatusRow = 0;
  const examples = [];

  for (const r of rows) {
    for (const inst of (r.sla_snapshot || [])) {
      if (!inst.isCompleted || !inst.resolvedAt) continue;
      checked++;
      const instResolvedMs = new Date(inst.resolvedAt).getTime();

      const { rows: statusRows } = await pool.query(`
        SELECT "createdAt" FROM issue_history
        WHERE "issueId" = $1 AND field = 'status'
          AND "createdAt" BETWEEN $2::timestamptz - interval '10 seconds' AND $2::timestamptz + interval '10 seconds'
        ORDER BY ABS(EXTRACT(EPOCH FROM ("createdAt" - $2::timestamptz))) ASC
        LIMIT 1
      `, [r.id, inst.resolvedAt]);

      if (!statusRows.length) { noStatusRow++; continue; }
      const drift = Math.abs(new Date(statusRows[0].createdAt).getTime() - instResolvedMs);

      if (drift === 0) { exactMatch++; continue; }
      if (drift <= 5000) {
        if (inst.isBreached) {
          driftedButBreached++;
        } else {
          driftedNotBreached++;
          if (examples.length < 25) examples.push(`${r.key}: ${inst.deptName} drift=${drift}ms, isBreached=false -- was showing a FALSE "SLA Breached" History badge before the fix`);
        }
      }
    }
  }

  console.log(`Resolved SLA instances checked: ${checked}`);
  console.log(`Exact timestamp match (never affected): ${exactMatch}`);
  console.log(`Small drift (<=5s), genuinely NOT breached -- WAS showing a false breach badge: ${driftedNotBreached}`);
  console.log(`Small drift (<=5s), genuinely breached (harmless either way): ${driftedButBreached}`);
  console.log(`No matching status row found within +/-10s (skipped): ${noStatusRow}`);
  console.log(`\nExamples of tickets that WERE showing a false breach badge (now fixed):`);
  for (const e of examples) console.log(' - ' + e);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
