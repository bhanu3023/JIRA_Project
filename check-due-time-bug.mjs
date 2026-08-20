/**
 * check-due-time-bug.mjs
 * READ-ONLY. Finds the ticket matching the screenshot (assignee "Bhagyashri
 * Deokar", Dev department, created ~14 Aug 3:53 PM) and traces the exact
 * dueTime computation step by step to find why a Medium-priority ticket
 * (24h goal per the Dev "Time to Resolution" policy) shows a DUE time only
 * ~19 minutes after START instead of 24 hours later.
 *
 * Run: DATABASE_URL=... node check-due-time-bug.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

async function main() {
  const r = await pool.query(`
    SELECT i.id, i.key, i.cf_key, i.priority, i."spaceId", i.current_department,
           i."createdAt", i."updatedAt", i."resolvedAt", i."dueDate",
           i.dept_sla_started_at, i.dept_sla_log, i.dept_statuses, i.jira_sla_breached,
           u."firstName", u."lastName"
    FROM issues i
    LEFT JOIN users u ON u.id = i."assigneeId"
    WHERE LOWER(i.current_department) = 'dev'
      AND i."createdAt" >= '2026-08-14T00:00:00Z' AND i."createdAt" < '2026-08-15T00:00:00Z'
      AND u."firstName" ILIKE 'Bhagyashri%'
    ORDER BY i."createdAt" ASC
  `);

  if (!r.rows.length) {
    console.log('No matching ticket found -- widening search to any department/day for this assignee...');
    const r2 = await pool.query(`
      SELECT i.id, i.key, i.cf_key, i.priority, i."spaceId", i.current_department,
             i."createdAt", i."resolvedAt", i.dept_sla_started_at, i.dept_sla_log,
             u."firstName", u."lastName"
      FROM issues i
      LEFT JOIN users u ON u.id = i."assigneeId"
      WHERE u."firstName" ILIKE 'Bhagyashri%'
        AND i."createdAt" >= '2026-08-13T00:00:00Z' AND i."createdAt" < '2026-08-16T00:00:00Z'
      ORDER BY i."createdAt" ASC
    `);
    console.log(JSON.stringify(r2.rows, null, 2));
    await pool.end();
    return;
  }

  for (const row of r.rows) {
    console.log(`\n════════════════════════════════════════════`);
    console.log(`Ticket: ${row.key} (${row.cf_key || 'no cf_key'})`);
    console.log(`Priority: ${row.priority}`);
    console.log(`Created: ${row.createdAt}`);
    console.log(`Resolved: ${row.resolvedAt}`);
    console.log(`current_department: ${row.current_department}`);
    console.log(`dept_sla_started_at: ${row.dept_sla_started_at}`);
    console.log(`dept_sla_log: ${JSON.stringify(row.dept_sla_log, null, 2)}`);
    console.log(`dept_statuses: ${JSON.stringify(row.dept_statuses, null, 2)}`);
    console.log(`jira_sla_breached: ${row.jira_sla_breached}`);

    const policies = await pool.query(
      `SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`,
      [row.spaceId]
    );
    const dev = policies.rows.filter((p) => (p.dept_name || '').trim().toLowerCase() === 'dev');
    console.log(`\nActive Dev-scoped SLA policies: ${dev.length}`);
    for (const p of dev) {
      console.log(`  Policy "${p.name}" (id=${p.id}):`);
      console.log(`    goals: ${JSON.stringify(p.goals)}`);
      console.log(`    pauseStatuses: ${JSON.stringify(p.pauseStatuses)}`);

      const priority = (row.priority || 'medium').toLowerCase();
      let durationMs = 8 * 60 * 60 * 1000;
      let matchedGoal = 'default 8h fallback';
      for (const goal of (p.goals || [])) {
        if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
          const g = goal.priorityRows.find((rr) => rr.priority?.toLowerCase() === priority);
          if (g?.timeValue) {
            const val = parseFloat(g.timeValue);
            const unit = (g.timeUnit || 'hours').toLowerCase();
            durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
            matchedGoal = `priorityRow match: ${JSON.stringify(g)}`;
            break;
          }
        } else if (goal.timeValue) {
          const val = parseFloat(goal.timeValue);
          const unit = (goal.timeUnit || 'hours').toLowerCase();
          durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
          matchedGoal = `flat goal match: ${JSON.stringify(goal)}`;
          break;
        }
      }
      console.log(`    matched: ${matchedGoal}`);
      console.log(`    durationMs computed = ${durationMs} (${durationMs / 3_600_000}h)`);

      const deptSlaLog = row.dept_sla_log || {};
      const deptLogKey = Object.keys(deptSlaLog).find((k) => k.toLowerCase() === 'dev');
      const deptLogEntry = deptLogKey ? deptSlaLog[deptLogKey] : null;
      const priorElapsedMs = deptLogEntry ? (deptLogEntry.elapsed_ms || 0) : 0;
      console.log(`    deptLogEntry: ${JSON.stringify(deptLogEntry)}`);
      console.log(`    priorElapsedMs = ${priorElapsedMs} (${priorElapsedMs / 3_600_000}h)`);

      const startedAt = row.dept_sla_started_at ? new Date(row.dept_sla_started_at) : new Date(row.createdAt);
      const remainingBudgetMs = Math.max(0, durationMs - priorElapsedMs);
      const dueTime = new Date(startedAt.getTime() + remainingBudgetMs);
      console.log(`    startedAt used = ${startedAt.toISOString()}`);
      console.log(`    remainingBudgetMs = durationMs(${durationMs}) - priorElapsedMs(${priorElapsedMs}) = ${remainingBudgetMs} (${remainingBudgetMs / 3_600_000}h)`);
      console.log(`    COMPUTED dueTime = ${dueTime.toISOString()}`);
    }
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
