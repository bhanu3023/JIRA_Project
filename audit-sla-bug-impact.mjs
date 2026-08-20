/**
 * audit-sla-bug-impact.mjs
 * READ-ONLY. For every ticket CREATED in a date range (default: 2026-08-10
 * through now, override with FROM/TO env vars), across every department:
 *   - prints created / updated / resolved / dueDate
 *   - computes SLA breach with the OLD (buggy, isSameStint-guarded) formula
 *     and the NEW (fixed, unconditional elapsed_ms) formula
 *   - flags every ticket where they DISAGREE -- i.e. every ticket the
 *     isSameStint bug was silently hiding a real breach on -- grouped by
 *     department, so you can see exactly which department each fixed
 *     breach belongs to.
 *
 * Nothing is written: SLA breach for the app's own department-SLA system is
 * always computed live from dept_sla_log/dept_sla_started_at, never stored
 * as a persisted "breached" flag on the ticket -- so once the code fix
 * (src/lib/jira-pg-api.ts) is deployed, every live view (Filters, queue
 * lists, the ticket detail panel) already reflects the corrected answer
 * automatically. This script only reports which tickets were affected, it
 * does not need to (and does not) change any stored data. The one exception
 * is `jira_sla_breached`, a separate historical flag imported from Jira for
 * old tickets -- that column is untouched by either formula's bug and is
 * not part of what changed here.
 *
 * Run: DATABASE_URL=... node audit-sla-bug-impact.mjs
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

function isBreached(row, policies, nowMs, useOldBuggyGuard) {
  const dept = (row.current_department || '').trim().toLowerCase();
  const priority = (row.priority || 'medium').toLowerCase();
  const currentStatusName = (row.status_name || '').trim().toLowerCase();
  const isResolved = row.status_category === 'done';
  const deptSlaLog = row.dept_sla_log || {};
  const deptLogKey = Object.keys(deptSlaLog).find((k) => k.toLowerCase() === dept);
  const deptLogEntry = deptLogKey ? deptSlaLog[deptLogKey] : null;

  let priorElapsedMs = 0;
  if (useOldBuggyGuard) {
    const currentStartedRaw = row.dept_sla_started_at;
    const isSameStint = deptLogEntry?.started_at && currentStartedRaw
      && new Date(deptLogEntry.started_at).getTime() === new Date(currentStartedRaw).getTime();
    priorElapsedMs = (deptLogEntry && !isSameStint) ? (deptLogEntry.elapsed_ms || 0) : 0;
  } else {
    priorElapsedMs = deptLogEntry ? (deptLogEntry.elapsed_ms || 0) : 0;
  }

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
    SELECT i.id, i.key, i.priority, i."createdAt", i."updatedAt", i."resolvedAt", i."dueDate",
           i.jira_sla_breached, i.dept_sla_started_at, i.dept_sla_log, i."spaceId",
           COALESCE(i.current_department, '(none)') AS current_department,
           s.name AS status_name, s.category AS status_category
    FROM issues i
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE i."createdAt" >= $1 AND i."createdAt" <= $2
  `, [FROM, TO]);

  const nowMs = Date.now();
  const policiesBySpace = new Map();
  const byDept = new Map(); // dept -> { total, oldBreached, newBreached, flippedTickets: [] }

  for (const row of rows.rows) {
    if (!policiesBySpace.has(row.spaceId)) {
      const p = await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`, [row.spaceId]);
      policiesBySpace.set(row.spaceId, p.rows);
    }
    const policies = policiesBySpace.get(row.spaceId);
    const dept = row.current_department;

    if (!byDept.has(dept)) byDept.set(dept, { total: 0, oldBreached: 0, newBreached: 0, flipped: [] });
    const bucket = byDept.get(dept);
    bucket.total++;

    const oldResult = isBreached(row, policies, nowMs, true);
    const newResult = isBreached(row, policies, nowMs, false);
    if (oldResult) bucket.oldBreached++;
    if (newResult) bucket.newBreached++;

    if (oldResult !== newResult) {
      bucket.flipped.push({
        key: row.key,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        resolvedAt: row.resolvedAt,
        dueDate: row.dueDate,
        wasShowing: oldResult ? 'breached' : 'not breached',
        nowShows: newResult ? 'breached' : 'not breached',
      });
    }
  }

  console.log('========== PER-DEPARTMENT SUMMARY ==========');
  let totalFlipped = 0;
  for (const [dept, b] of [...byDept.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`\n${dept}: ${b.total} tickets created in range`);
    console.log(`  Breached under OLD (buggy) formula: ${b.oldBreached}`);
    console.log(`  Breached under NEW (fixed) formula: ${b.newBreached}`);
    console.log(`  Tickets whose breach status the bug got WRONG: ${b.flipped.length}`);
    if (b.flipped.length) {
      totalFlipped += b.flipped.length;
      for (const f of b.flipped.slice(0, 20)) {
        console.log(`    ${f.key}: created=${new Date(f.createdAt).toISOString()} updated=${new Date(f.updatedAt).toISOString()} resolved=${f.resolvedAt ? new Date(f.resolvedAt).toISOString() : '(not resolved)'} dueDate=${f.dueDate ? new Date(f.dueDate).toISOString() : '(none)'} -- was "${f.wasShowing}", correctly now "${f.nowShows}"`);
      }
      if (b.flipped.length > 20) console.log(`    ... and ${b.flipped.length - 20} more`);
    }
  }

  console.log(`\n========== TOTAL ==========`);
  console.log(`Total tickets in range: ${rows.rows.length}`);
  console.log(`Total tickets whose breach status the isSameStint bug got wrong: ${totalFlipped}`);
  console.log(totalFlipped
    ? 'These are already corrected automatically now that the code fix is deployed -- no data was stored incorrectly, only computed incorrectly at read time. Nothing further needs to change in the database.'
    : 'No tickets in this range were affected by the bug.');

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
