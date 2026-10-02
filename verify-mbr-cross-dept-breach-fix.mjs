// Find real tickets that passed through BOTH Migration and Dev (so the
// cross-department breach-attribution bug could actually have affected
// them), and show each department's own elapsed_ms vs goal so we can
// manually confirm which department ACTUALLY breached -- ground truth to
// check the live MBR endpoint's post-fix output against. Read-only.
//
// Usage: node verify-mbr-cross-dept-breach-fix.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.key, i.cf_key, i.current_department, i.priority, i."resolvedAt", i.dept_sla_log
    FROM issues i
    WHERE i.dept_sla_log ? 'Migration' AND i.dept_sla_log ? 'Dev'
      AND i."resolvedAt" IS NOT NULL
    ORDER BY i."resolvedAt" DESC
    LIMIT 15
  `);

  const { rows: migPol } = await pool.query(`SELECT goals FROM sla_definitions WHERE dept_name = 'Migration' AND status = 'active' LIMIT 1`);
  const { rows: devPol } = await pool.query(`SELECT goals FROM sla_definitions WHERE dept_name = 'Dev' AND status = 'active' LIMIT 1`);
  const goalHoursFor = (goals, priority) => {
    for (const g of goals || []) {
      if (g.isPriorityGroup) {
        const row = (g.priorityRows || []).find(r => r.priority?.toLowerCase() === priority.toLowerCase());
        if (row?.timeValue) return parseFloat(row.timeValue);
      }
    }
    return null;
  };

  console.log(`Found ${rows.length} resolved tickets that passed through both Migration and Dev:\n`);
  for (const t of rows) {
    const key = t.cf_key || t.key;
    const mig = t.dept_sla_log['Migration'];
    const dev = t.dept_sla_log['Dev'];
    const migHrs = (mig?.elapsed_ms || 0) / 3_600_000;
    const devHrs = (dev?.elapsed_ms || 0) / 3_600_000;
    const migGoal = goalHoursFor(migPol[0]?.goals, t.priority);
    const devGoal = goalHoursFor(devPol[0]?.goals, t.priority);
    const migBreached = migGoal !== null && migHrs > migGoal;
    const devBreached = devGoal !== null && devHrs > devGoal;
    console.log(`${key} (priority=${t.priority}, currently in: ${t.current_department})`);
    console.log(`  Migration: ${migHrs.toFixed(1)}h elapsed vs ${migGoal}h goal -> ${migBreached ? 'BREACHED' : 'ok'}`);
    console.log(`  Dev:       ${devHrs.toFixed(1)}h elapsed vs ${devGoal}h goal -> ${devBreached ? 'BREACHED' : 'ok'}`);
    if (migBreached !== devBreached) {
      console.log(`  *** MISMATCH CANDIDATE: only ${migBreached ? 'Migration' : 'Dev'} actually breached -- this is exactly the kind of ticket the bug could misattribute. ***`);
    }
    console.log('');
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
