// The live GET /api/issues/CF-33286 endpoint (computeSLAInstancesPure) says
// isBreached: false for Migration, but Filters shows "Breached: Yes". Rather
// than guess further from reading the code, this replicates
// computeSlaBreachedAndOverdue's EXACT logic (jira-pg-api.ts ~2604-2767)
// against the SAME data Filters actually fetches (same SELECT columns, same
// active-only sla_definitions query), printing every intermediate value to
// find exactly where it diverges from the correct "not breached" answer.
//
// Read-only.
//
// Usage: node check-cf33286-filters-sla-logic.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT i.id, i.priority, i."createdAt", i."dueDate", i."spaceId", i.current_department,
            i.dept_statuses, i.jira_sla_breached, i.dept_sla_started_at, i.dept_sla_log, i.sla_waivers,
            s.name AS status_name, s.category AS status_category
     FROM issues i LEFT JOIN statuses s ON i."statusId" = s.id
     WHERE i.cf_key = 'CF-33286' OR i.key = 'CF-33286'`
  );
  const r = rows[0];
  console.log('Raw row Filters would fetch:');
  console.log(JSON.stringify(r, null, 2));

  const { rows: policyRows } = await pool.query(
    `SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`,
    [r.spaceId]
  );
  console.log(`\nActive policies for this space: ${policyRows.length}`);
  for (const p of policyRows) console.log(`  ${p.name}: ${JSON.stringify(p.goals)}`);

  // ── Exact replica of computeSlaBreachedAndOverdue ──
  const i = { ...r, status: r.status_name ? { name: r.status_name, category: r.status_category } : null };
  const deptParam = 'Migration'; // matches the screenshot's Migration-scoped view
  const nowMs = Date.now();

  const issueDeptForStatus = (i.current_department || '').trim().toLowerCase();
  const deptStatusesForStatus = i.dept_statuses || {};
  const deptStatusKeyForStatus = Object.keys(deptStatusesForStatus).find((k) => k.toLowerCase() === issueDeptForStatus);
  const deptStatusCategoryForStatus = deptStatusKeyForStatus ? deptStatusesForStatus[deptStatusKeyForStatus]?.category : undefined;
  const isResolved = i.status?.category === 'done' || deptStatusCategoryForStatus === 'done';
  console.log(`\nisResolved: ${isResolved} (status.category=${i.status?.category}, deptStatusCategoryForStatus=${deptStatusCategoryForStatus})`);

  let breached = !!i.jira_sla_breached;
  console.log(`initial breached (from jira_sla_breached=${JSON.stringify(i.jira_sla_breached)}, typeof=${typeof i.jira_sla_breached}): ${breached}`);

  const dept = (deptParam || i.current_department || '').trim().toLowerCase();
  console.log(`dept: "${dept}"`);

  const hasApplicablePolicy = policyRows.some((p) => {
    const pDept = (p.dept_name || '').trim().toLowerCase();
    return !pDept || pDept === dept;
  });
  console.log(`hasApplicablePolicy: ${hasApplicablePolicy}`);

  if (!breached) {
    if (!isResolved && i.dueDate && new Date(i.dueDate).getTime() < nowMs) { breached = true; console.log('breached via dueDate check'); }
    const slaStartedAt = i.dept_sla_started_at || i.createdAt;
    console.log(`slaStartedAt: ${slaStartedAt ? new Date(slaStartedAt).toISOString() : 'NULL'}`);
    if (!breached && slaStartedAt) {
      const priority = (i.priority || 'medium').toLowerCase();
      const currentStatusName = (i.status?.name || '').trim().toLowerCase();
      console.log(`priority: ${priority}   currentStatusName: "${currentStatusName}"`);
      const policies = policyRows.filter((p) => {
        const pDept = (p.dept_name || '').trim().toLowerCase();
        return !pDept || pDept === dept;
      });
      const waivers = i.sla_waivers || {};
      for (const policy of policies) {
        console.log(`\n-- policy: ${policy.name} --`);
        const pauseStatuses = Array.isArray(policy.pauseStatuses) ? policy.pauseStatuses.map((s) => s.trim().toLowerCase()) : [];
        console.log(`   pauseStatuses: ${JSON.stringify(pauseStatuses)}`);
        if (pauseStatuses.includes(currentStatusName)) { console.log('   PAUSED at current status -- skipped'); continue; }
        let durationMs = 8 * 60 * 60 * 1000;
        for (const goal of (policy.goals || [])) {
          if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
            const row = goal.priorityRows.find((rr) => rr.priority?.toLowerCase() === priority);
            if (row?.timeValue) {
              const val = parseFloat(row.timeValue);
              const unit = (row.timeUnit || 'hours').toLowerCase();
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
        console.log(`   durationMs: ${durationMs} (${durationMs/3600000}h)`);
        const deptSlaLog = i.dept_sla_log || {};
        const deptLogKey = Object.keys(deptSlaLog).find((k) => k.toLowerCase() === dept);
        const deptLogEntry = deptLogKey ? deptSlaLog[deptLogKey] : null;
        const priorElapsedMs = deptLogEntry ? (deptLogEntry.elapsed_ms || 0) : 0;
        console.log(`   deptLogKey: ${deptLogKey}   priorElapsedMs: ${priorElapsedMs} (${priorElapsedMs/3600000}h)`);
        const waiver = waivers[policy.id] || null;
        const deptClockIsLive = isResolved ? false : !deptParam || (i.current_department || '').trim().toLowerCase() === dept;
        console.log(`   deptClockIsLive: ${deptClockIsLive}   waiver: ${JSON.stringify(waiver)}`);
        if (isResolved || !deptClockIsLive) {
          const wouldBreach = priorElapsedMs >= durationMs && !waiver;
          console.log(`   [FROZEN CLOCK] ${priorElapsedMs} >= ${durationMs} && !waiver => ${wouldBreach}`);
          if (wouldBreach) { breached = true; break; }
        } else {
          const remainingBudgetMs = Math.max(0, durationMs - priorElapsedMs);
          const wouldBreach = new Date(slaStartedAt).getTime() + remainingBudgetMs < nowMs && !waiver;
          console.log(`   [LIVE CLOCK] slaStartedAt+remaining < now => ${wouldBreach}`);
          if (wouldBreach) { breached = true; break; }
        }
      }
    }
  }

  const slaBreached = hasApplicablePolicy || i.jira_sla_breached ? breached : null;
  console.log(`\n\nFINAL slaBreached: ${slaBreached}`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
