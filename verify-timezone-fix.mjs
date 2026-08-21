/**
 * verify-timezone-fix.mjs
 * READ-ONLY. check-due-time-bug.mjs and check-timezone-bug.mjs each create
 * their own standalone pg.Pool, so they never actually load
 * src/lib/pg-pool.ts's fix (a separate `node script.mjs` process never
 * imports that module) -- their unchanged output after the fix was deployed
 * is expected, NOT a sign the fix failed.
 *
 * This script applies the EXACT same one-line fix
 * (pg.types.setTypeParser(1114, ...)) inline, before creating its Pool, to
 * prove the fix logic itself produces the correct due-time computation --
 * this is what the running app (which DOES import pg-pool.ts) now does on
 * every raw-SQL read.
 *
 * Run: DATABASE_URL=... node verify-timezone-fix.mjs
 */
import pg from 'pg';

// The exact fix from src/lib/pg-pool.ts.
pg.types.setTypeParser(1114, (str) => new Date(str + 'Z'));

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

async function main() {
  const r = await pool.query(`
    SELECT i.id, i.key, i.cf_key, i.priority, i."spaceId", i.current_department,
           i."createdAt", i."createdAt"::text AS created_at_text,
           i."resolvedAt", i.dept_sla_started_at, i.dept_sla_log
    FROM issues i
    WHERE i.key = 'L1BOAR-15243'
  `);
  const row = r.rows[0];
  console.log(`Ticket: ${row.key} (${row.cf_key})`);
  console.log(`createdAt (with fix applied): ${row.createdAt.toISOString()}`);
  console.log(`createdAt raw text (ground truth, no parsing): ${row.created_at_text}`);
  console.log(`Matches ground truth: ${row.createdAt.toISOString().slice(0, 19) === row.created_at_text.replace(' ', 'T').slice(0, 19)}`);

  const policies = await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`, [row.spaceId]);
  const dev = policies.rows.find((p) => (p.dept_name || '').trim().toLowerCase() === 'dev');
  const priority = (row.priority || 'medium').toLowerCase();
  let durationMs = 8 * 60 * 60 * 1000;
  for (const goal of (dev.goals || [])) {
    if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
      const g = goal.priorityRows.find((rr) => rr.priority?.toLowerCase() === priority);
      if (g?.timeValue) {
        const val = parseFloat(g.timeValue);
        const unit = (g.timeUnit || 'hours').toLowerCase();
        durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
        break;
      }
    }
  }
  const deptLog = row.dept_sla_log || {};
  const deptLogEntry = deptLog.Dev || null;
  const priorElapsedMs = deptLogEntry ? (deptLogEntry.elapsed_ms || 0) : 0;
  const startedAt = row.dept_sla_started_at ? new Date(row.dept_sla_started_at) : row.createdAt;
  const remainingBudgetMs = Math.max(0, durationMs - priorElapsedMs);
  const dueTime = new Date(startedAt.getTime() + remainingBudgetMs);

  console.log(`\ndurationMs (Medium priority goal): ${durationMs / 3_600_000}h`);
  console.log(`priorElapsedMs (logged elapsed time): ${(priorElapsedMs / 3_600_000).toFixed(2)}h`);
  console.log(`startedAt: ${startedAt.toISOString()}`);
  console.log(`remainingBudgetMs: ${(remainingBudgetMs / 3_600_000).toFixed(2)}h`);
  console.log(`OLD dueTime formula (anchored to startedAt): ${dueTime.toISOString()}`);
  const resolvedAtDate = row.resolvedAt ? new Date(row.resolvedAt) : null;
  console.log(`resolvedAt: ${resolvedAtDate ? resolvedAtDate.toISOString() : '(none)'}`);
  if (resolvedAtDate) {
    const newDueTime = new Date(resolvedAtDate.getTime() + (durationMs - priorElapsedMs));
    console.log(`NEW dueTime formula (anchored to resolvedAt, the actual deployed fix): ${newDueTime.toISOString()}`);
    console.log(`(resolvedAt is ${((newDueTime.getTime() - resolvedAtDate.getTime()) / 60000).toFixed(1)} minutes ${newDueTime > resolvedAtDate ? 'before' : 'after'} the deadline)`);
  }
  console.log(`\nSince priorElapsedMs (${(priorElapsedMs / 3_600_000).toFixed(2)}h) is already >= durationMs (${durationMs / 3_600_000}h): ${priorElapsedMs >= durationMs ? 'YES -- this ticket IS breached per the resolved-ticket formula.' : 'NO -- not breached by that check, but see remainingBudgetMs above.'}`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
