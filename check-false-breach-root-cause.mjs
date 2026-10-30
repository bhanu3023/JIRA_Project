// Read-only: find WHY 1491 tickets are flagged isBreached=true in their own
// frozen sla_snapshot despite actualElapsedMs < goalDurationMs (the daily
// consistency check's own falsePositiveBreach count). Same query shape that
// check uses, but keeps full rows instead of just counting, to sample and
// classify the actual cause.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT id, key, cf_key, "createdAt", "resolvedAt", current_department, dept_sla_log, sla_snapshot, sla_waivers, jira_sla_breached
    FROM issues
    WHERE sla_snapshot IS NOT NULL AND jsonb_array_length(sla_snapshot) > 0
  `);

  const falsePositives = [];
  for (const row of rows) {
    const waivers = row.sla_waivers || {};
    for (const inst of row.sla_snapshot || []) {
      if (typeof inst.actualElapsedMs === 'number' && typeof inst.goalDurationMs === 'number') {
        if (inst.isBreached && !waivers[inst.policyId] && inst.actualElapsedMs < inst.goalDurationMs) {
          falsePositives.push({ key: row.cf_key || row.key, inst, jira_sla_breached: row.jira_sla_breached, deptLog: row.dept_sla_log });
        }
      }
    }
  }
  console.log(`Total false-positive breach instances: ${falsePositives.length}\n`);

  // Classify by how far off the ratio is, and whether jira_sla_breached is involved
  let jiraFlagInvolved = 0, closeCall = 0, wildlyOff = 0;
  for (const fp of falsePositives) {
    if (fp.jira_sla_breached) jiraFlagInvolved++;
    const ratio = fp.inst.actualElapsedMs / fp.inst.goalDurationMs;
    if (ratio > 0.9) closeCall++;
    if (ratio < 0.3) wildlyOff++;
  }
  console.log(`jira_sla_breached=true on the ticket: ${jiraFlagInvolved} / ${falsePositives.length}`);
  console.log(`"close call" (actual >90% of goal, could be a rounding/race): ${closeCall}`);
  console.log(`"wildly off" (actual <30% of goal): ${wildlyOff}`);

  console.log(`\nSample of 15:`);
  for (const fp of falsePositives.slice(0, 15)) {
    console.log(` - ${fp.key} | policy=${fp.inst.policyName} dept=${fp.inst.deptName} | actual=${(fp.inst.actualElapsedMs/3600000).toFixed(2)}h goal=${(fp.inst.goalDurationMs/3600000).toFixed(2)}h | isCompleted=${fp.inst.isCompleted} isPaused=${fp.inst.isPaused} | waived=${fp.inst.waived} | jira_sla_breached=${fp.jira_sla_breached}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
