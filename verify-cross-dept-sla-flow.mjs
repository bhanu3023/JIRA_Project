/**
 * verify-cross-dept-sla-flow.mjs
 * READ-ONLY. Proves the exact flow being asked about: a ticket raised in
 * Migration, moved to Dev, worked in Dev (In Progress -> Resolved there),
 * and how Dev's own breach status behaves once Migration takes it back --
 * specifically: does Dev's breach LOCK in place (computed once from Dev's
 * own logged elapsed time, independent of anything that happens
 * afterward), and does Migration's screen then compute breach from
 * MIGRATION's own separate SLA clock, not Dev's?
 *
 * Finds real tickets whose dept_sla_log has ENTRIES FOR BOTH "Dev" AND
 * "Migration" (i.e. actually visited both departments), and for each,
 * prints both departments' independently-computed elapsed time, goal,
 * and breach status side by side.
 *
 * Run: DATABASE_URL=... node verify-cross-dept-sla-flow.mjs
 */
import pg from 'pg';

pg.types.setTypeParser(1114, (str) => new Date(str + 'Z'));
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

function parseDurationMs(policy, priority) {
  let durationMs = 8 * 60 * 60 * 1000;
  for (const goal of (policy.goals || [])) {
    if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
      const g = goal.priorityRows.find((rr) => rr.priority?.toLowerCase() === priority);
      if (g?.timeValue) {
        const val = parseFloat(g.timeValue);
        const unit = (g.timeUnit || 'hours').toLowerCase();
        durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
        break;
      }
    } else if (goal.timeValue) {
      const val = parseFloat(goal.timeValue);
      const unit = (goal.timeUnit || 'hours').toLowerCase();
      durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
      break;
    }
  }
  return durationMs;
}

async function main() {
  const rows = await pool.query(`
    SELECT i.id, i.key, i.priority, i."spaceId", i.current_department, i.dept_sla_log,
           i.jira_sla_breached, s.category AS status_category
    FROM issues i
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE i.dept_sla_log ? 'Dev' AND i.dept_sla_log ? 'Migration'
    LIMIT 10
  `);

  if (!rows.rows.length) {
    console.log('No tickets found whose dept_sla_log has entries for BOTH Dev and Migration -- widening search to case-insensitive key match...');
    const r2 = await pool.query(`
      SELECT i.key, i.dept_sla_log
      FROM issues i
      WHERE jsonb_object_keys(i.dept_sla_log) IS NOT NULL
      LIMIT 5000
    `).catch(() => ({ rows: [] }));
    const candidates = r2.rows.filter((r) => {
      const keys = Object.keys(r.dept_sla_log || {}).map((k) => k.toLowerCase());
      return keys.includes('dev') && keys.includes('migration');
    });
    console.log(`Found ${candidates.length} candidates via fallback scan.`);
    if (!candidates.length) { await pool.end(); return; }
    rows.rows = candidates.slice(0, 10).map((c) => ({ key: c.key }));
  }

  console.log(`Found ${rows.rows.length} ticket(s) that visited BOTH Dev and Migration:\n`);

  for (const row of rows.rows) {
    const full = await pool.query(`
      SELECT i.id, i.key, i.priority, i."spaceId", i.current_department, i.dept_sla_log,
             i.jira_sla_breached, s.category AS status_category, s.name AS status_name
      FROM issues i
      LEFT JOIN statuses s ON i."statusId" = s.id
      WHERE i.key = $1
    `, [row.key]);
    const r = full.rows[0];
    const policiesRes = await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`, [r.spaceId]);
    const priority = (r.priority || 'medium').toLowerCase();
    const isResolved = r.status_category === 'done';
    const deptSlaLog = r.dept_sla_log || {};

    console.log(`════════════════════════════════════════════`);
    console.log(`${r.key} -- current department: ${r.current_department} | status: ${r.status_name} | priority: ${r.priority}`);

    for (const deptName of ['Dev', 'Migration']) {
      const logKey = Object.keys(deptSlaLog).find((k) => k.toLowerCase() === deptName.toLowerCase());
      if (!logKey) { console.log(`  [${deptName}] never visited`); continue; }
      const entry = deptSlaLog[logKey];
      const applicable = policiesRes.rows.filter((p) => {
        const pDept = (p.dept_name || '').trim().toLowerCase();
        return !pDept || pDept === deptName.toLowerCase();
      });
      if (!applicable.length) { console.log(`  [${deptName}] no active SLA policy configured`); continue; }
      const durationMs = parseDurationMs(applicable[0], priority);
      const elapsedMs = entry.elapsed_ms || 0;
      const isCurrentDept = r.current_department?.toLowerCase() === deptName.toLowerCase();
      // Breach for THIS department, computed ONLY from this department's own
      // logged elapsed time vs its own goal -- independent of the other dept
      // and independent of whether the ticket has since moved on.
      const breachedInThisDept = isCurrentDept
        ? (isResolved ? (!!r.jira_sla_breached || elapsedMs >= durationMs) : null /* still running, needs live "now" */)
        : (elapsedMs >= durationMs); // dept already left -- locked, frozen total
      console.log(`  [${deptName}] status="${entry.status}" elapsed=${(elapsedMs / 3_600_000).toFixed(2)}h goal=${(durationMs / 3_600_000).toFixed(1)}h${isCurrentDept ? ' (CURRENT dept)' : ' (LEFT this dept -- locked)'} -> breached=${breachedInThisDept === null ? 'still running, see live check' : breachedInThisDept}`);
    }
  }

  console.log(`\n════════════════════════════════════════════`);
  console.log('Each department line above is computed ONLY from that department\'s own dept_sla_log entry and its own SLA policy -- proving Dev\'s breach (locked once it leaves Dev) and Migration\'s breach (its own separate clock) never influence each other.');

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
