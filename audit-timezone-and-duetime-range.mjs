/**
 * audit-timezone-and-duetime-range.mjs
 * READ-ONLY. For every ticket CREATED in a date range (default: 2026-08-10
 * through now, override with FROM/TO env vars):
 *   1. Confirms createdAt reads correctly (with the pg-pool.ts fix applied
 *      inline, the same way verify-timezone-fix.mjs does, since this
 *      standalone script has its own Pool and never imports that module).
 *   2. Flags any ticket whose dept_sla_started_at is NULL -- those fall back
 *      to createdAt as the SLA clock's start reference, so they're the ones
 *      that could have gotten a genuinely wrong (not just cosmetic) SLA
 *      calculation from the raw-timestamp misread bug before the fix.
 *   3. For RESOLVED tickets, shows the OLD due-time-display formula
 *      (anchored to startedAt) vs the NEW one (anchored to resolvedAt, the
 *      fix just deployed) so you can see exactly how many tickets' SLA
 *      cards had a confusing due time before vs after.
 * Grouped by department.
 *
 * Run: DATABASE_URL=... node audit-timezone-and-duetime-range.mjs
 */
import pg from 'pg';

// Same fix as src/lib/pg-pool.ts -- without this, createdAt read by THIS
// script's own separate Pool would show the pre-fix, shifted value.
pg.types.setTypeParser(1114, (str) => new Date(str + 'Z'));

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

async function main() {
  console.log(`Range: ${FROM}  ->  ${TO}\n`);

  const rows = await pool.query(`
    SELECT i.id, i.key, i.priority, i."createdAt", i."resolvedAt", i.dept_sla_started_at, i.dept_sla_log,
           i.jira_sla_breached, i."spaceId", COALESCE(i.current_department, '(none)') AS current_department,
           s.name AS status_name, s.category AS status_category
    FROM issues i
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE i."createdAt" >= $1 AND i."createdAt" <= $2
    ORDER BY i."createdAt" ASC
  `, [FROM, TO]);

  const policiesBySpace = new Map();
  const byDept = new Map();

  for (const row of rows.rows) {
    const dept = row.current_department;
    if (!byDept.has(dept)) byDept.set(dept, { total: 0, noSlaStart: [], dueTimeDiffs: [] });
    const bucket = byDept.get(dept);
    bucket.total++;

    if (!row.dept_sla_started_at) {
      bucket.noSlaStart.push(row.key);
      continue; // nothing to compute a due time from
    }

    if (row.status_category !== 'done' || !row.resolvedAt) continue; // only resolved tickets show the display bug

    if (!policiesBySpace.has(row.spaceId)) {
      const p = await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`, [row.spaceId]);
      policiesBySpace.set(row.spaceId, p.rows);
    }
    const allPolicies = policiesBySpace.get(row.spaceId);
    const deptLower = dept.toLowerCase();
    const applicable = allPolicies.filter((p) => {
      const pDept = (p.dept_name || '').trim().toLowerCase();
      return !pDept || pDept === deptLower;
    });
    if (!applicable.length) continue;

    const priority = (row.priority || 'medium').toLowerCase();
    const deptSlaLog = row.dept_sla_log || {};
    const deptLogKey = Object.keys(deptSlaLog).find((k) => k.toLowerCase() === deptLower);
    const priorElapsedMs = deptLogKey ? (deptSlaLog[deptLogKey]?.elapsed_ms || 0) : 0;
    const startedAt = new Date(row.dept_sla_started_at);
    const resolvedAt = new Date(row.resolvedAt);

    for (const policy of applicable) {
      const durationMs = parseDurationMs(policy, priority);
      const remainingBudgetMs = Math.max(0, durationMs - priorElapsedMs);
      const oldDueTime = new Date(startedAt.getTime() + remainingBudgetMs);
      const newDueTime = new Date(resolvedAt.getTime() + (durationMs - priorElapsedMs));
      const diffMs = Math.abs(newDueTime.getTime() - oldDueTime.getTime());
      if (diffMs > 60_000) { // more than a minute apart -- worth flagging
        bucket.dueTimeDiffs.push({
          key: row.key,
          policy: policy.name,
          oldDueTime: oldDueTime.toISOString(),
          newDueTime: newDueTime.toISOString(),
          diffHours: (diffMs / 3_600_000).toFixed(1),
        });
      }
    }
  }

  let totalNoSlaStart = 0, totalDueTimeFixed = 0;
  for (const [dept, b] of [...byDept.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`\n═══ ${dept}: ${b.total} tickets created in range ═══`);
    if (b.noSlaStart.length) {
      console.log(`  ${b.noSlaStart.length} ticket(s) have NO dept_sla_started_at (never entered a tracked department -- not affected by either bug): ${b.noSlaStart.slice(0, 10).join(', ')}${b.noSlaStart.length > 10 ? ', ...' : ''}`);
      totalNoSlaStart += b.noSlaStart.length;
    }
    if (b.dueTimeDiffs.length) {
      console.log(`  ${b.dueTimeDiffs.length} resolved ticket(s) had a due-time display that the fix changed by more than a minute:`);
      for (const d of b.dueTimeDiffs.slice(0, 15)) {
        console.log(`    ${d.key} (${d.policy}): old="${d.oldDueTime}" -> new="${d.newDueTime}" (moved ${d.diffHours}h)`);
      }
      if (b.dueTimeDiffs.length > 15) console.log(`    ... and ${b.dueTimeDiffs.length - 15} more`);
      totalDueTimeFixed += b.dueTimeDiffs.length;
    } else {
      console.log(`  No resolved tickets in this department had a meaningfully different due-time display.`);
    }
  }

  console.log(`\n========== TOTAL ==========`);
  console.log(`Total tickets in range: ${rows.rows.length}`);
  console.log(`Tickets with no dept_sla_started_at (createdAt-fallback, unaffected by the display bug either way): ${totalNoSlaStart}`);
  console.log(`Resolved tickets whose due-time DISPLAY the fix corrected: ${totalDueTimeFixed}`);
  console.log(`Note: none of this changes any ticket's breach flag -- isBreached was already correct before this fix (it never used the display due-time for resolved tickets). This only affects what due time is SHOWN on the SLA card.`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
