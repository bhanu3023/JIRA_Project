// Widen the search: scan up to 2000 resolved tickets that passed through
// both Migration and Dev, and print ONLY the ones where exactly one side
// actually breached -- these are the real cases the cross-department
// attribution bug could have gotten wrong, and the ones worth checking
// against the live MBR endpoint post-fix. Read-only.
//
// Usage: node verify-mbr-mismatch-cases.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.key, i.cf_key, i.current_department, i.priority, i."resolvedAt", i.dept_sla_log
    FROM issues i
    WHERE i.dept_sla_log ? 'Migration' AND i.dept_sla_log ? 'Dev'
      AND i."resolvedAt" IS NOT NULL
    ORDER BY i."resolvedAt" DESC
    LIMIT 2000
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

  let mismatches = 0;
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
    if (migBreached !== devBreached) {
      mismatches++;
      console.log(`${key} (priority=${t.priority}, currently in: ${t.current_department}, resolved: ${new Date(t.resolvedAt).toISOString().slice(0,10)})`);
      console.log(`  Migration: ${migHrs.toFixed(1)}h vs ${migGoal}h goal -> ${migBreached ? 'BREACHED' : 'ok'}`);
      console.log(`  Dev:       ${devHrs.toFixed(1)}h vs ${devGoal}h goal -> ${devBreached ? 'BREACHED' : 'ok'}`);
      console.log(`  Expected: only ${migBreached ? 'Migration' : 'Dev'} should count this ticket as breached.\n`);
    }
    if (mismatches >= 10) break;
  }
  console.log(`\nScanned ${rows.length} tickets, found ${mismatches} mismatch case(s) shown above.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
