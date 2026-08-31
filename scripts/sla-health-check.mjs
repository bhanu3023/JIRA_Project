// Read-only SLA health check: replicates the app's own computeSLAInstancesPure
// logic (src/lib/jira-pg-api.ts) against real open Dev/Migration tickets and
// reports any case where the live-computed breach status looks inconsistent
// with the raw due-time math, for manual spot-checking.

import pg from 'pg';
const { Client } = pg;

function computeDueAndBreach(issue, policy) {
  const priority = (issue.priority || 'medium').toLowerCase();
  let durationMs = 8 * 60 * 60 * 1000;
  for (const goal of (policy.goals || [])) {
    if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
      const row = goal.priorityRows.find((r) => (r.priority || '').toLowerCase() === priority);
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

  const pauseStatuses = (policy.pauseStatuses || []).map((s) => s.trim().toLowerCase());
  const currentStatusName = (issue.status_name || '').trim().toLowerCase();
  const isPaused = pauseStatuses.includes(currentStatusName);

  const dept = (issue.current_department || '').trim().toLowerCase();
  const deptLog = issue.dept_sla_log || {};
  const logKey = Object.keys(deptLog).find((k) => k.toLowerCase() === dept);
  const priorElapsedMs = logKey ? (deptLog[logKey].elapsed_ms || 0) : 0;

  const remainingBudgetMs = Math.max(0, durationMs - priorElapsedMs);
  const startedAt = issue.dept_sla_started_at ? new Date(issue.dept_sla_started_at) : new Date(issue.createdAt);
  const dueTime = new Date(startedAt.getTime() + remainingBudgetMs);
  const isBreached = !isPaused && dueTime < new Date();

  return { durationMs, priorElapsedMs, dueTime, isBreached, isPaused, priority };
}

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;
  const client = new Client({ connectionString });
  await client.connect();

  const { rows: policies } = await client.query(`SELECT * FROM sla_definitions WHERE status = 'active'`);
  const { rows: issues } = await client.query(`
    SELECT i.id, i.cf_key, i.priority, i.current_department, i.dept_sla_started_at, i.dept_sla_log,
           i."createdAt", i.jira_sla_breached, s.name AS status_name, s.category
    FROM issues i
    LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE s.category != 'done' AND LOWER(i.current_department) IN ('dev','migration')
    ORDER BY i.dept_sla_started_at ASC NULLS LAST
  `);

  console.log(`Open Dev/Migration tickets: ${issues.length}`);
  let breachedCount = 0, notBreachedCount = 0;
  const flagged = [];

  for (const issue of issues) {
    const dept = (issue.current_department || '').trim().toLowerCase();
    const policy = policies.find((p) => (p.dept_name || '').trim().toLowerCase() === dept);
    if (!policy) continue;
    const r = computeDueAndBreach(issue, policy);
    if (r.isBreached) breachedCount++; else notBreachedCount++;

    // Flag anything that looks inconsistent: breached but due time barely
    // passed (<5min, could be a race at check-time) is fine to skip; flag
    // cases where elapsed time is wildly beyond duration but not breached,
    // or breached with negative/zero elapsed (shouldn't happen).
    const hoursOverdue = (Date.now() - r.dueTime.getTime()) / 3_600_000;
    if (!r.isBreached && hoursOverdue > 1) {
      flagged.push({ key: issue.cf_key, issue: 'overdue but not breached', hoursOverdue: hoursOverdue.toFixed(1), priority: r.priority, dept });
    }
    if (r.isBreached && hoursOverdue < 0) {
      flagged.push({ key: issue.cf_key, issue: 'breached but due time is in the future', hoursOverdue: hoursOverdue.toFixed(1), priority: r.priority, dept });
    }
  }

  console.log(`Breached: ${breachedCount}, Not breached: ${notBreachedCount}`);
  console.log(`\nAnomalies found: ${flagged.length}`);
  for (const f of flagged.slice(0, 20)) console.log(' ', JSON.stringify(f));

  await client.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
