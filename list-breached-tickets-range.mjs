/**
 * list-breached-tickets-range.mjs
 * READ-ONLY. Lists every ticket CREATED in a date range (default:
 * 2026-08-10 through now, override with FROM/TO env vars) that is
 * currently SLA-breached, using the same accurate formula as the fixed
 * list/filter endpoint. Grouped by department.
 *
 * Run: DATABASE_URL=... node list-breached-tickets-range.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});
const FROM = process.env.FROM || '2026-08-10T00:00:00Z';
const TO = process.env.TO || new Date().toISOString();

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

function isBreached(row, policies, nowMs) {
  const dept = (row.current_department || '').trim().toLowerCase();
  const priority = (row.priority || 'medium').toLowerCase();
  const currentStatusName = (row.status_name || '').trim().toLowerCase();
  const isResolved = row.status_category === 'done';
  const deptSlaLog = row.dept_sla_log || {};
  const deptLogKey = Object.keys(deptSlaLog).find((k) => k.toLowerCase() === dept);
  const deptLogEntry = deptLogKey ? deptSlaLog[deptLogKey] : null;
  const priorElapsedMs = deptLogEntry ? (deptLogEntry.elapsed_ms || 0) : 0;

  if (row.jira_sla_breached) return true;

  const applicable = policies.filter((p) => {
    const pDept = (p.dept_name || '').trim().toLowerCase();
    return !pDept || pDept === dept;
  });
  for (const policy of applicable) {
    const pauseStatuses = Array.isArray(policy.pauseStatuses) ? policy.pauseStatuses.map((s) => s.trim().toLowerCase()) : [];
    if (!isResolved && pauseStatuses.includes(currentStatusName)) continue;
    const durationMs = parseDurationMs(policy, priority);
    if (isResolved) {
      if (priorElapsedMs >= durationMs) return true;
    } else {
      const slaStartedAt = row.dept_sla_started_at || row.createdAt;
      const remainingBudgetMs = Math.max(0, durationMs - priorElapsedMs);
      if (new Date(slaStartedAt).getTime() + remainingBudgetMs < nowMs) return true;
    }
  }
  return false;
}

async function main() {
  console.log(`Range: ${FROM}  ->  ${TO}\n`);

  const rows = await pool.query(`
    SELECT i.key, i.priority, i."createdAt", i."resolvedAt", i.jira_sla_breached,
           i.dept_sla_started_at, i.dept_sla_log, i."spaceId",
           COALESCE(i.current_department, '(none)') AS current_department,
           s.name AS status_name, s.category AS status_category
    FROM issues i
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE i."createdAt" >= $1 AND i."createdAt" <= $2
    ORDER BY i."createdAt" ASC
  `, [FROM, TO]);

  const nowMs = Date.now();
  const policiesBySpace = new Map();
  const byDept = new Map();

  for (const row of rows.rows) {
    if (!policiesBySpace.has(row.spaceId)) {
      const p = await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`, [row.spaceId]);
      policiesBySpace.set(row.spaceId, p.rows);
    }
    const policies = policiesBySpace.get(row.spaceId);
    if (!isBreached(row, policies, nowMs)) continue;

    const dept = row.current_department;
    if (!byDept.has(dept)) byDept.set(dept, []);
    byDept.get(dept).push(row);
  }

  let total = 0;
  for (const [dept, tickets] of [...byDept.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n═══ ${dept}: ${tickets.length} breached ═══`);
    for (const t of tickets) {
      const status = t.status_category === 'done'
        ? (t.resolvedAt ? `resolved ${new Date(t.resolvedAt).toISOString()}` : `resolved (no resolvedAt recorded -- status "${t.status_name}")`)
        : `still open (${t.status_name})`;
      console.log(`  ${t.key}  created=${new Date(t.createdAt).toISOString()}  ${status}  priority=${t.priority || 'medium'}`);
    }
    total += tickets.length;
  }

  console.log(`\n========== TOTAL BREACHED (created in range): ${total} ==========`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
