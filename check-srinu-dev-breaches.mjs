// Read-only: verify the 12 tickets shown under Queue=Dev, Assignee=Srinu,
// SLA Breached=Yes are REAL breaches -- i.e. Dev's own dept_sla_log.elapsed_ms
// genuinely exceeds Dev's own SLA goal duration for that ticket's priority,
// not an artifact of the attribution fix. Prints the raw numbers behind each
// ticket's verdict so they can be checked by hand.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';
const DEPT = 'Dev';

function durationMsForPriority(policy, priority) {
  for (const goal of (policy.goals || [])) {
    if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
      const row = goal.priorityRows.find((r) => (r.priority || '').toLowerCase() === priority);
      if (row && row.timeValue !== undefined && row.timeValue !== null && row.timeValue !== '') {
        const val = parseFloat(row.timeValue);
        const unit = (row.timeUnit || 'hours').toLowerCase();
        return unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
      }
    } else if (goal.timeValue) {
      const val = parseFloat(goal.timeValue);
      const unit = (goal.timeUnit || 'hours').toLowerCase();
      return unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
    }
  }
  return 8 * 60 * 60 * 1000;
}

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [SPACE_KEY]);
  const spaceId = spaceRows[0]?.id;

  const { rows: userRows } = await pool.query(
    `SELECT id FROM users WHERE LOWER(email) LIKE '%srinu%gudimitla%' OR (LOWER("firstName") LIKE '%srinu%' AND LOWER("lastName") LIKE '%gudimitla%')`
  );
  const srinuId = userRows[0]?.id;
  console.log('Srinu user id:', srinuId, userRows[0]);

  const { rows: polRows } = await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`, [spaceId]);
  const devPolicies = polRows.filter((p) => {
    const d = (p.dept_name || '').trim().toLowerCase();
    return !d || d === 'dev';
  });
  console.log(`\nFound ${devPolicies.length} active policy(ies) applicable to Dev.`);

  // Tickets currently assigned to Srinu, OR with a worked-on-Dev credit row for Srinu.
  const { rows: tickets } = await pool.query(
    `SELECT i.id, i.key, i.cf_key, i.priority, i.dept_sla_log, i.current_department, i."assigneeId", s.category AS status_category, s.name AS status_name
     FROM issues i
     LEFT JOIN statuses s ON s.id = i."statusId"
     WHERE i."spaceId" = $1
       AND (
         i."assigneeId" = $2
         OR EXISTS (SELECT 1 FROM user_worked_on_tickets w WHERE w.issue_id = i.id AND w.user_id = $2 AND LOWER(w.dept) = 'dev')
         OR EXISTS (SELECT 1 FROM jsonb_each(COALESCE(i.dept_assignees,'{}'::jsonb)) da(k,v) WHERE LOWER(k)='dev' AND v->>'id' = $2)
       )
     ORDER BY i."createdAt" DESC`,
    [spaceId, srinuId]
  );
  console.log(`\n${tickets.length} candidate tickets (assigned to or worked by Srinu, Dev-related).\n`);

  let realBreaches = 0, notBreached = 0, noDevLog = 0;
  for (const t of tickets) {
    const deptSlaLog = t.dept_sla_log || {};
    const devKey = Object.keys(deptSlaLog).find((k) => k.toLowerCase() === 'dev');
    const devEntry = devKey ? deptSlaLog[devKey] : null;
    if (!devEntry) { noDevLog++; continue; }
    const elapsedMs = devEntry.elapsed_ms || 0;
    const priority = (t.priority || 'medium').toLowerCase();
    const durations = devPolicies.map((p) => ({ name: p.name, durationMs: durationMsForPriority(p, priority) }));
    const minDuration = durations.length ? Math.min(...durations.map((d) => d.durationMs)) : null;
    const breached = minDuration != null && elapsedMs >= minDuration;
    if (breached) realBreaches++; else notBreached++;
    console.log(
      `${t.cf_key || t.key} | priority=${priority} | status=${t.status_name} | Dev elapsed=${(elapsedMs / 3600000).toFixed(2)}h | Dev goal=${minDuration != null ? (minDuration / 3600000).toFixed(2) + 'h' : 'n/a'} | Dev-log-status=${devEntry.status} | BREACHED(Dev)=${breached}`
    );
  }
  console.log(`\nSummary: ${realBreaches} real Dev breaches, ${notBreached} not breached, ${noDevLog} with no Dev SLA log at all.`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
