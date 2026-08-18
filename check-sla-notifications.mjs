/**
 * check-sla-notifications.mjs
 *
 * Read-only diagnostic: prints every SLA_BREACH notification ever sent for a
 * given ticket key (accepts either the local key like L1BOAR-123 or the
 * Jira-style cf_key like CF-29414), plus that ticket's active SLA policies
 * and each one's computed due time -- so we can see exactly which policy
 * fired a "breaching soon" notification and why, instead of guessing.
 *
 * Run: node check-sla-notifications.mjs CF-29414
 */
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const rawKey = process.argv[2];
if (!rawKey) {
  console.error('Usage: node check-sla-notifications.mjs <ticket-key>');
  process.exit(1);
}

async function main() {
  const issueRes = await pool.query(
    `SELECT id, key, cf_key, "spaceId", priority, current_department, dept_sla_started_at, dept_sla_log, "createdAt"
     FROM issues WHERE key = $1 OR cf_key = $1 LIMIT 1`,
    [rawKey]
  );
  const issue = issueRes.rows[0];
  if (!issue) { console.log(`No issue found for key "${rawKey}"`); await pool.end(); return; }
  console.log('--- Issue ---');
  console.log({ key: issue.key, cf_key: issue.cf_key, priority: issue.priority, dept: issue.current_department, sla_started_at: issue.dept_sla_started_at, dept_sla_log: issue.dept_sla_log });

  console.log('\n--- SLA_BREACH notifications sent for this ticket ---');
  const notifRes = await pool.query(
    `SELECT title, message, "createdAt" FROM notifications WHERE "issueKey" = $1 AND type = 'SLA_BREACH' ORDER BY "createdAt" ASC`,
    [issue.cf_key || issue.key]
  );
  if (!notifRes.rows.length) console.log('(none found)');
  for (const n of notifRes.rows) console.log(`[${n.createdAt.toISOString()}] ${n.title} -- ${n.message}`);

  console.log('\n--- Active SLA policies applicable to this ticket (dept-restricted or global) ---');
  const polRes = await pool.query(
    `SELECT id, name, dept_name, goals FROM sla_definitions
     WHERE "spaceId" = $1 AND status = 'active'
       AND (dept_name IS NULL OR dept_name = '' OR LOWER(dept_name) = LOWER($2))`,
    [issue.spaceId, issue.current_department || '']
  );
  const priority = (issue.priority || 'medium').toLowerCase();
  for (const p of polRes.rows) {
    let durationMs = null;
    for (const goal of (p.goals || [])) {
      if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
        const row = goal.priorityRows.find((r) => r.priority?.toLowerCase() === priority);
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
    const startedAt = issue.dept_sla_started_at ? new Date(issue.dept_sla_started_at) : new Date(issue.createdAt);
    const dueAt = durationMs != null ? new Date(startedAt.getTime() + durationMs) : null;
    console.log({
      policy: p.name, dept_name: p.dept_name, durationHours: durationMs != null ? (durationMs / 3_600_000).toFixed(2) : null,
      dueAt: dueAt ? dueAt.toISOString() : null,
    });
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
