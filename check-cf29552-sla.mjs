/**
 * check-cf29552-sla.mjs
 * READ-ONLY. The Filters page, with Queue=Migration + Created=last 7 days +
 * SLA Breached=Yes, returns 0 issues -- but CF-29552's own ticket detail
 * page correctly shows it as BREACHED (1h 48m overdue). This replicates the
 * exact breach formula the Filters/issues list endpoint uses
 * (src/lib/jira-pg-api.ts, around the "Breached field" comment) against
 * CF-29552's real stored data, to see exactly which input it disagrees on.
 *
 * Run: DATABASE_URL=... node check-cf29552-sla.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

async function main() {
  const r = await pool.query(`
    SELECT i.id, i.key, i.cf_key, i."spaceId", i.current_department, i."createdAt", i."updatedAt",
           i."dueDate", i.jira_sla_breached, i.dept_sla_started_at, i.dept_sla_log, i.priority,
           s.name AS status_name, s.category AS status_category
    FROM issues i
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE i.cf_key = 'CF-29552' OR i.key = 'CF-29552'
  `);
  if (!r.rows[0]) {
    console.log('CF-29552 not found by cf_key or key -- check the exact identifier.');
    await pool.end();
    return;
  }
  const row = r.rows[0];
  console.log('Raw stored data for CF-29552:');
  console.log(JSON.stringify(row, null, 2));

  const policies = await pool.query(
    `SELECT * FROM sla_definitions WHERE "spaceId" = $1`,
    [row.spaceId]
  );
  console.log(`\nsla_definitions rows for spaceId=${row.spaceId}: ${policies.rows.length}`);
  console.log(JSON.stringify(policies.rows, null, 2));

  // Replicate the exact formula from jira-pg-api.ts's list-endpoint breach check.
  const nowMs = Date.now();
  const isResolved = row.status_category === 'done';
  let breached = !!row.jira_sla_breached;
  const trace = [`jira_sla_breached=${!!row.jira_sla_breached}`];

  if (!breached && !isResolved) {
    const dueBreach = row.dueDate && new Date(row.dueDate).getTime() < nowMs;
    trace.push(`dueDate=${row.dueDate} -> dueBreach=${!!dueBreach}`);
    if (dueBreach) breached = true;

    if (!breached) {
      const slaStartedAt = row.dept_sla_started_at || row.createdAt;
      trace.push(`slaStartedAt=${slaStartedAt}`);
      const dept = (row.current_department || '').trim().toLowerCase();
      const priority = (row.priority || 'medium').toLowerCase();
      const currentStatusName = (row.status_name || '').trim().toLowerCase();
      const activePolicies = policies.rows.filter((p) => p.status === 'active').filter((p) => {
        const pDept = (p.dept_name || '').trim().toLowerCase();
        return !pDept || pDept === dept;
      });
      trace.push(`active policies matching dept="${dept}": ${activePolicies.length}`);
      for (const policy of activePolicies) {
        const pauseStatuses = Array.isArray(policy.pauseStatuses) ? policy.pauseStatuses.map((s) => s.trim().toLowerCase()) : [];
        if (pauseStatuses.includes(currentStatusName)) { trace.push(`policy "${policy.name}": paused (status "${currentStatusName}" in pauseStatuses)`); continue; }
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
        const dueAt = new Date(slaStartedAt).getTime() + durationMs;
        const wouldBreach = dueAt < nowMs;
        trace.push(`policy "${policy.name}": durationMs=${durationMs} -> computed due=${new Date(dueAt).toISOString()} -> breach=${wouldBreach}`);
        if (wouldBreach) { breached = true; break; }
      }
    }
  } else if (isResolved) {
    trace.push('ticket status category is "done" -- list formula never marks a resolved ticket breached (this matches CF-29552 only if it were resolved, which it is not per the screenshot: "In Progress")');
  }

  console.log('\nStep-by-step trace:');
  console.log(trace.join('\n'));
  console.log(`\nFinal computed breached = ${breached}`);
  console.log(breached
    ? 'This SHOULD have shown up under SLA Breached: Yes -- if it genuinely did not, something else (query/filter combination) is dropping it before this computation even runs.'
    : 'This computation itself says NOT breached -- that is the actual bug: it disagrees with the ticket detail page. Check which trace line differs from what the ticket page uses.');

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
