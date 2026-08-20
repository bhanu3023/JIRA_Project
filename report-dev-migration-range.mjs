/**
 * report-dev-migration-range.mjs
 * READ-ONLY. For Dev and Migration: total tickets CREATED in a date range,
 * and how many of THOSE are currently SLA-breached -- using the exact same
 * accurate per-policy breach formula as the fixed list/filter endpoint
 * (priorElapsedMs carryover + isSameStint guard, see verify-sla-cap-fix.mjs
 * and src/lib/jira-pg-api.ts).
 *
 * Range defaults to 2026-08-10T00:00:00Z through now; override with
 * FROM=<ISO date> TO=<ISO date> env vars.
 *
 * Run: DATABASE_URL=... node report-dev-migration-range.mjs
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
  const currentStartedRaw = row.dept_sla_started_at;
  const isSameStint = deptLogEntry?.started_at && currentStartedRaw
    && new Date(deptLogEntry.started_at).getTime() === new Date(currentStartedRaw).getTime();
  const priorElapsedMs = (deptLogEntry && !isSameStint) ? (deptLogEntry.elapsed_ms || 0) : 0;

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

async function reportDept(dept, spaceId) {
  const policiesRes = await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`, [spaceId]);
  const policies = policiesRes.rows;

  const rows = await pool.query(`
    SELECT i.id, i.key, i.priority, i."createdAt", i."dueDate", i.jira_sla_breached,
           i.dept_sla_started_at, i.dept_sla_log, i.current_department,
           s.name AS status_name, s.category AS status_category
    FROM issues i
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE LOWER(i.current_department) = LOWER($1) AND i."spaceId" = $2
      AND i."createdAt" >= $3 AND i."createdAt" <= $4
  `, [dept, spaceId, FROM, TO]);

  const nowMs = Date.now();
  const total = rows.rows.length;
  const breachedRows = rows.rows.filter((r) => isBreached(r, policies, nowMs));
  console.log(`${dept}: total created = ${total} | breached = ${breachedRows.length}`);
  return { total, breached: breachedRows.length };
}

async function main() {
  console.log(`Range: ${FROM}  ->  ${TO}\n`);
  const spaceRow = await pool.query(`
    SELECT DISTINCT "spaceId" FROM issues WHERE LOWER(current_department) IN ('dev', 'migration') LIMIT 5
  `);
  let devTotal = 0, devBreached = 0, migTotal = 0, migBreached = 0;
  for (const { spaceId } of spaceRow.rows) {
    const d = await reportDept('Dev', spaceId);
    const m = await reportDept('Migration', spaceId);
    devTotal += d.total; devBreached += d.breached;
    migTotal += m.total; migBreached += m.breached;
  }
  console.log('\n========== TOTALS ==========');
  console.log(`Dev       -- created: ${devTotal}, breached: ${devBreached}`);
  console.log(`Migration -- created: ${migTotal}, breached: ${migBreached}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
