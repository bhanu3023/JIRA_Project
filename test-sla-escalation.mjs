// Live test for the SLA escalation chain (commit c95d676): temporarily backdates
// a REAL Migration or Dev ticket's SLA clock so it falls inside the 30-min warning
// window, triggers the exact same scan the app runs every 30s, and reports who it
// actually notified -- then restores the ticket to its original state.
//
// Usage (run inside the jira_app container):
//   node test-sla-escalation.mjs find migration|dev        dry run: pick a candidate, show what would change
//   node test-sla-escalation.mjs apply migration|dev       backdate it, trigger the scan, report notifications sent
//   node test-sla-escalation.mjs restore                   undo the backdate (always run this after apply)
import pg from 'pg';
import fs from 'fs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const BACKUP_FILE = '/tmp/sla-escalation-test-backup.json';
const WARN_LEFT_MS = 25 * 60 * 1000; // leave ~25 min until breach (inside the 30-min window)

const ESCALATION_CHAINS = {
  migration: ['pg_5qkf2zt9u4', 'pg_fvt6f6gq80', 'pg_7da8vs32an', 'pg_3qs010ohxf', 'usr_sujana_manapuram_cloudfuze_com'],
  dev: ['pg_3lc6y8c9x7', 'pg_7da8vs32an', 'pg_3qs010ohxf', 'usr_sujana_manapuram_cloudfuze_com'],
};

function parseGoalDurationMs(policy, priority) {
  const goals = Array.isArray(policy.goals) ? policy.goals : [];
  for (const goal of goals) {
    if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
      const row = goal.priorityRows.find((r) => (r.priority || '').toLowerCase() === priority);
      if (row && row.timeValue !== undefined && row.timeValue !== null && row.timeValue !== '') {
        const val = parseFloat(row.timeValue);
        if (val === 0) return null;
        const unit = (row.timeUnit || 'hours').toLowerCase();
        return unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
      }
    } else if (goal.timeValue) {
      const val = parseFloat(goal.timeValue);
      if (val === 0) return null;
      const unit = (goal.timeUnit || 'hours').toLowerCase();
      return unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
    }
  }
  return 8 * 60 * 60 * 1000;
}

async function findCandidate(dept) {
  const { rows } = await pool.query(
    `SELECT i.id, i.key, i.cf_key, i.priority, i."spaceId", i.current_department, i.dept_sla_started_at, i.dept_sla_log, i.summary
     FROM issues i
     LEFT JOIN statuses s ON i."statusId" = s.id
     WHERE i.dept_sla_started_at IS NOT NULL
       AND LOWER(i.current_department) = $1
       AND (s.category IS NULL OR s.category != 'done')
     ORDER BY i."updatedAt" DESC
     LIMIT 20`,
    [dept],
  );
  for (const row of rows) {
    const log = row.dept_sla_log || {};
    const deptKey = Object.keys(log).find((k) => k.toLowerCase() === dept);
    const entry = deptKey ? log[deptKey] : null;
    // Prefer a simple case: no pause, this department's clock actually running.
    if (!entry || entry.status === 'running') {
      const { rows: polRows } = await pool.query(
        `SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`,
        [row.spaceId],
      );
      const policy = polRows.find((p) => (p.dept_name || '').toLowerCase() === dept) || polRows[0];
      if (!policy) continue;
      const goalDurationMs = parseGoalDurationMs(policy, (row.priority || 'medium').toLowerCase());
      if (!goalDurationMs) continue;
      return { row, policy, goalDurationMs, deptKey, entry };
    }
  }
  return null;
}

async function cmdFind(dept) {
  const candidate = await findCandidate(dept);
  if (!candidate) {
    console.log(`No suitable active ${dept} ticket found (need one with an active SLA policy, not paused, not done).`);
    return;
  }
  const { row, goalDurationMs } = candidate;
  const offsetMs = Math.max(60_000, goalDurationMs - WARN_LEFT_MS);
  const newStartedAt = new Date(Date.now() - offsetMs);
  console.log(`Candidate: ${row.cf_key || row.key} (${row.summary})`);
  console.log(`  priority=${row.priority}  goalDurationMs=${goalDurationMs} (${(goalDurationMs / 3_600_000).toFixed(2)}h)`);
  console.log(`  current dept_sla_started_at = ${row.dept_sla_started_at}`);
  console.log(`  would set dept_sla_started_at = ${newStartedAt.toISOString()}  (~${Math.round(WARN_LEFT_MS / 60000)} min left until breach)`);
  console.log(`\nRun: node test-sla-escalation.mjs apply ${dept}`);
}

async function cmdApply(dept) {
  if (fs.existsSync(BACKUP_FILE)) {
    console.log(`A backup already exists at ${BACKUP_FILE} -- run "restore" first before starting a new test.`);
    return;
  }
  const candidate = await findCandidate(dept);
  if (!candidate) {
    console.log(`No suitable active ${dept} ticket found.`);
    return;
  }
  const { row, goalDurationMs, deptKey, entry } = candidate;
  const offsetMs = Math.max(60_000, goalDurationMs - WARN_LEFT_MS);
  const newStartedAt = new Date(Date.now() - offsetMs);

  const backup = {
    issueId: row.id,
    key: row.cf_key || row.key,
    dept,
    original_dept_sla_started_at: row.dept_sla_started_at,
    original_dept_sla_log: row.dept_sla_log,
  };
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));

  const newLog = { ...(row.dept_sla_log || {}) };
  if (deptKey) {
    newLog[deptKey] = { ...(entry || {}), status: 'running', paused_at: null, elapsed_ms: 0, started_at: newStartedAt.toISOString() };
  }

  await pool.query(
    `UPDATE issues SET dept_sla_started_at = $1, dept_sla_log = $2::jsonb WHERE id = $3`,
    [newStartedAt.toISOString(), JSON.stringify(newLog), row.id],
  );
  console.log(`Backdated ${backup.key}: dept_sla_started_at -> ${newStartedAt.toISOString()} (~${Math.round(WARN_LEFT_MS / 60000)} min left). Backup saved to ${BACKUP_FILE}.`);

  console.log('Triggering the scan (POST /api/monitor-agent)...');
  const res = await fetch('http://localhost:8080/api/monitor-agent', { method: 'POST' });
  const result = await res.json().catch(() => ({}));
  console.log('Scan result:', result);

  const { rows: notifs } = await pool.query(
    `SELECT n."userId", n.title, n.message, n."createdAt", u."firstName", u."lastName", u.email
     FROM notifications n JOIN users u ON u.id = n."userId"
     WHERE n."issueKey" = $1 AND n.type = 'SLA_BREACH' AND n."createdAt" > NOW() - INTERVAL '5 minutes'
     ORDER BY n."createdAt" DESC`,
    [backup.key],
  );
  if (!notifs.length) {
    console.log(`\nNo SLA_BREACH notification rows were created for ${backup.key}. The ticket may not have landed in the warning window -- try "restore" then "apply" again, or check that an active SLA policy covers ${dept} priority=${row.priority}.`);
  } else {
    console.log(`\n${notifs.length} notification row(s) created for ${backup.key}:`);
    for (const n of notifs) console.log(`  ${n.firstName} ${n.lastName} <${n.email}>  userId=${n.userId}`);
    const chain = ESCALATION_CHAINS[dept] || [];
    const notifiedIds = new Set(notifs.map((n) => n.userId));
    console.log(`\nEscalation chain for ${dept}: ${chain.join(', ')}`);
    for (const id of chain) console.log(`  ${id}: ${notifiedIds.has(id) ? 'NOTIFIED' : 'missing'}`);
  }
  console.log(`\nCheck email inboxes for the escalation chain users now, then run: node test-sla-escalation.mjs restore`);
}

async function cmdRestore() {
  if (!fs.existsSync(BACKUP_FILE)) {
    console.log('No backup file found -- nothing to restore.');
    return;
  }
  const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
  await pool.query(
    `UPDATE issues SET dept_sla_started_at = $1, dept_sla_log = $2::jsonb WHERE id = $3`,
    [backup.original_dept_sla_started_at, JSON.stringify(backup.original_dept_sla_log || {}), backup.issueId],
  );
  const { rowCount } = await pool.query(
    `DELETE FROM notifications WHERE "issueKey" = $1 AND type = 'SLA_BREACH' AND "createdAt" > NOW() - INTERVAL '1 hour'`,
    [backup.key],
  );
  fs.unlinkSync(BACKUP_FILE);
  console.log(`Restored ${backup.key} to its original dept_sla_started_at/dept_sla_log, and removed ${rowCount} test notification row(s).`);
}

async function main() {
  const [, , mode, dept] = process.argv;
  if (mode === 'find' && (dept === 'migration' || dept === 'dev')) await cmdFind(dept);
  else if (mode === 'apply' && (dept === 'migration' || dept === 'dev')) await cmdApply(dept);
  else if (mode === 'restore') await cmdRestore();
  else console.log('Usage: node test-sla-escalation.mjs find|apply migration|dev   OR   node test-sla-escalation.mjs restore');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
