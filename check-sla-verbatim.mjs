// Read-only: runs a VERBATIM transcription (types stripped only) of
// computeSlaBreachedAndOverdue / isSlaInstanceBreached / getHistoricalOverrideDurationMs
// from src/lib/jira-pg-api.ts against CF-34482's real DB data, to settle --
// with zero risk of a hand-math transcription error -- whether the Dev-scoped
// verdict the live app computes for it is really "true", and if so, exactly
// which policy triggers it.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const HISTORICAL_SLA_OVERRIDES = {
  migration: { beforeMs: Date.parse('2026-09-28T10:57:56.000Z'), hoursByPriority: { medium: 10 } },
  dev: { beforeMs: Date.parse('2026-09-28T10:57:19.000Z'), hoursByPriority: { highest: 6, high: 8, medium: 24, low: 48, lowest: 48 } },
};
function getHistoricalOverrideDurationMs(deptName, priority, periodStartMs) {
  const override = HISTORICAL_SLA_OVERRIDES[(deptName || '').trim().toLowerCase()];
  if (!override || !(periodStartMs < override.beforeMs)) return null;
  const hours = override.hoursByPriority[(priority || '').trim().toLowerCase()];
  return typeof hours === 'number' ? hours * 3_600_000 : null;
}
function isSlaInstanceBreached(opts) {
  if (opts.isResolved) {
    if (opts.priorElapsedMs >= opts.durationMs) return true;
    if (!opts.hasDeptLogEntry && opts.jiraSlaBreached) return true;
    return false;
  }
  if (opts.isPaused) return false;
  return opts.dueTimeMs < opts.nowMs;
}
function computeSlaBreachedAndOverdue(i, deptParam, policiesBySpace, nowMs) {
  const issueDeptForStatus = (i.current_department || '').trim().toLowerCase();
  const deptStatusesForStatus = i.dept_statuses || {};
  const deptStatusKeyForStatus = Object.keys(deptStatusesForStatus).find((k) => k.toLowerCase() === issueDeptForStatus);
  const deptStatusCategoryForStatus = deptStatusKeyForStatus ? deptStatusesForStatus[deptStatusKeyForStatus]?.category : undefined;
  const deptSlaLogForStatus = i.dept_sla_log || {};
  const deptLogKeyForStatus = Object.keys(deptSlaLogForStatus).find((k) => k.toLowerCase() === issueDeptForStatus);
  const deptLogEntryForStatus = deptLogKeyForStatus ? deptSlaLogForStatus[deptLogKeyForStatus] : null;
  const deptClockGenuinelyStoppedForStatus = !deptLogEntryForStatus || deptLogEntryForStatus.status !== 'running';
  const isResolved = i.status?.category === 'done' || (deptStatusCategoryForStatus === 'done' && deptClockGenuinelyStoppedForStatus);
  console.log('[debug] isResolved =', isResolved);
  let breached = false;
  let hasRealDeptTracking = false;
  if (isResolved && Array.isArray(i.sla_snapshot) && i.sla_snapshot.length) {
    console.log('[debug] FROZEN SNAPSHOT SHORTCUT HIT');
    const snapshotWaivers = i.sla_waivers || {};
    return { slaBreached: i.sla_snapshot.some((x) => !snapshotWaivers[x.policyId] && x.isBreached), overdue: false };
  }
  console.log('[debug] frozen shortcut NOT hit -- falling through to live per-policy computation');
  const dept = (deptParam || i.current_department || '').trim().toLowerCase();
  const hasApplicablePolicy = (policiesBySpace[i.spaceId] || []).some((p) => {
    const pDept = (p.dept_name || '').trim().toLowerCase();
    return !pDept || pDept === dept;
  });
  if (!breached) {
    if (!isResolved && i.dueDate && new Date(i.dueDate).getTime() < nowMs) breached = true;
    const slaStartedAt = i.dept_sla_started_at || i.createdAt;
    if (!breached && slaStartedAt) {
      const priority = (i.priority || 'medium').toLowerCase();
      const currentStatusName = (i.status?.name || '').trim().toLowerCase();
      const policies = (policiesBySpace[i.spaceId] || []).filter((p) => {
        const pDept = (p.dept_name || '').trim().toLowerCase();
        return !pDept || pDept === dept;
      });
      const waivers = i.sla_waivers || {};
      for (const policy of policies) {
        const pauseStatuses = Array.isArray(policy.pauseStatuses) ? policy.pauseStatuses.map((s) => s.trim().toLowerCase()) : [];
        if (pauseStatuses.includes(currentStatusName)) continue;
        let durationMs = 8 * 60 * 60 * 1000;
        let priorityRemoved = false;
        for (const goal of (policy.goals || [])) {
          if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
            const row = goal.priorityRows.find((r) => r.priority?.toLowerCase() === priority);
            if (row && row.timeValue !== undefined && row.timeValue !== null && row.timeValue !== '') {
              const val = parseFloat(row.timeValue);
              if (val === 0) { priorityRemoved = true; break; }
              const unit = (row.timeUnit || 'hours').toLowerCase();
              durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
              break;
            }
          } else if (goal.timeValue) {
            const val = parseFloat(goal.timeValue);
            if (val === 0) { priorityRemoved = true; break; }
            const unit = (goal.timeUnit || 'hours').toLowerCase();
            durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
            break;
          }
        }
        if (priorityRemoved) continue;
        const overrideMs = getHistoricalOverrideDurationMs(dept, priority, new Date(slaStartedAt).getTime());
        if (overrideMs !== null) durationMs = overrideMs;
        const deptSlaLog = i.dept_sla_log || {};
        const deptLogKey = Object.keys(deptSlaLog).find((k) => k.toLowerCase() === dept);
        const deptLogEntry = deptLogKey ? deptSlaLog[deptLogKey] : null;
        if (deptLogEntry) hasRealDeptTracking = true;
        const priorElapsedMs = deptLogEntry ? (deptLogEntry.elapsed_ms || 0) : 0;
        const waiver = waivers[policy.id] || null;
        const deptClockIsLive = isResolved ? false : !deptParam || (i.current_department || '').trim().toLowerCase() === dept;
        const frozen = isResolved || !deptClockIsLive;
        const remainingBudgetMs = durationMs - priorElapsedMs;
        const dueTimeMs = new Date(slaStartedAt).getTime() + remainingBudgetMs;
        const instanceBreached = isSlaInstanceBreached({ isResolved: frozen, isPaused: false, priorElapsedMs, durationMs, dueTimeMs, nowMs });
        console.log(`[debug] policy ${policy.id} (dept_name=${policy.dept_name}) durationMs=${durationMs} priorElapsedMs=${priorElapsedMs} instanceBreached=${instanceBreached}`);
        if (instanceBreached && !waiver) { breached = true; break; }
      }
    }
  }
  if (!breached && !hasRealDeptTracking && i.jira_sla_breached) breached = true;
  const slaBreached = hasApplicablePolicy || i.jira_sla_breached ? breached : null;
  return { slaBreached, overdue: false };
}

async function main() {
  const { rows } = await pool.query(
    `SELECT i.*, s.name AS status_name, s.category AS status_category
     FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
     WHERE i.cf_key = 'CF-34482' OR i.key = 'CF-34482'`
  );
  const row = rows[0];
  const i = {
    spaceId: row.spaceId, priority: row.priority, createdAt: row.createdAt, dueDate: row.dueDate,
    current_department: row.current_department, dept_statuses: row.dept_statuses, jira_sla_breached: row.jira_sla_breached,
    dept_sla_started_at: row.dept_sla_started_at, dept_sla_log: row.dept_sla_log, sla_waivers: row.sla_waivers,
    sla_snapshot: row.sla_snapshot, status: { name: row.status_name, category: row.status_category },
  };
  const { rows: polRows } = await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`, [row.spaceId]);
  const policiesBySpace = { [row.spaceId]: polRows };

  console.log('=== Running verbatim function for deptParam="Dev" ===');
  console.log(computeSlaBreachedAndOverdue(i, 'Dev', policiesBySpace, Date.now()));

  console.log('\n=== Running verbatim function for deptParam=null (unscoped) ===');
  console.log(computeSlaBreachedAndOverdue(i, null, policiesBySpace, Date.now()));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
