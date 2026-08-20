/**
 * verify-sla-cap-fix.mjs
 * READ-ONLY. Directly answers: did raising SLA_PREFILTER_CAP actually recover
 * breached tickets that the old 5000-row cap was hiding in the Dev/Migration
 * queue filter?
 *
 * For each of Dev and Migration, this replicates the EXACT same per-ticket
 * breach formula the list/filter endpoint uses (priorElapsedMs carryover +
 * isSameStint guard, see src/lib/jira-pg-api.ts) against:
 *   (a) ALL matching tickets in that department (what the fixed code now sees)
 *   (b) only the newest 5000 by createdAt DESC (what the OLD buggy cap saw)
 * and reports the breached count for each, plus which specific tickets were
 * only found in (a) -- i.e. tickets the old cap was actively hiding.
 *
 * Run: DATABASE_URL=... node verify-sla-cap-fix.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});
const OLD_CAP = 5000;

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
  // No "same stint" guard -- see jira-pg-api.ts's comment on this same
  // formula. pauseDeptSLA's elapsed_ms is already a running incremental
  // total, never double-counted, so it's read unconditionally here to match.
  const priorElapsedMs = deptLogEntry ? (deptLogEntry.elapsed_ms || 0) : 0;

  if (row.jira_sla_breached) return true;

  const applicable = policies.filter((p) => {
    const pDept = (p.dept_name || '').trim().toLowerCase();
    return !pDept || pDept === dept;
  });
  for (const policy of applicable) {
    const pauseStatuses = Array.isArray(policy.pauseStatuses) ? policy.pauseStatuses.map((s) => s.trim().toLowerCase()) : [];
    if (!isResolved && pauseStatuses.includes(currentStatusName)) continue; // paused
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

async function checkDept(dept, spaceId) {
  console.log(`\n═══ ${dept} ═══`);
  const policiesRes = await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`, [spaceId]);
  const policies = policiesRes.rows;

  const allRows = await pool.query(`
    SELECT i.id, i.key, i.priority, i."createdAt", i."dueDate", i.jira_sla_breached,
           i.dept_sla_started_at, i.dept_sla_log, i.current_department,
           s.name AS status_name, s.category AS status_category
    FROM issues i
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE LOWER(i.current_department) = LOWER($1) AND i."spaceId" = $2
    ORDER BY i."createdAt" DESC
  `, [dept, spaceId]);

  const nowMs = Date.now();
  const full = allRows.rows;
  const capped = full.slice(0, OLD_CAP);

  const fullBreachedKeys = new Set(full.filter((r) => isBreached(r, policies, nowMs)).map((r) => r.key));
  const cappedBreachedKeys = new Set(capped.filter((r) => isBreached(r, policies, nowMs)).map((r) => r.key));

  const recovered = [...fullBreachedKeys].filter((k) => !cappedBreachedKeys.has(k));

  console.log(`Total ${dept} tickets: ${full.length} (old cap was ${OLD_CAP}, ${full.length > OLD_CAP ? `so ${full.length - OLD_CAP} oldest tickets were excluded entirely under the old code` : 'so the cap never actually excluded anything here'})`);
  console.log(`Breached count -- ALL tickets (what the FIXED code now returns): ${fullBreachedKeys.size}`);
  console.log(`Breached count -- newest ${OLD_CAP} only (what the OLD buggy code returned): ${cappedBreachedKeys.size}`);
  console.log(`Breached tickets the old cap was hiding: ${recovered.length}`);
  if (recovered.length) {
    console.log(`Sample recovered keys: ${recovered.slice(0, 15).join(', ')}${recovered.length > 15 ? ', ...' : ''}`);
  }
}

async function main() {
  const spaceRow = await pool.query(`
    SELECT DISTINCT "spaceId" FROM issues WHERE LOWER(current_department) IN ('dev', 'migration') LIMIT 5
  `);
  // Most deployments have exactly one space carrying department routing; if there's more than
  // one, run the check against each so nothing is silently skipped.
  const spaceIds = spaceRow.rows.map((r) => r.spaceId);
  for (const spaceId of spaceIds) {
    console.log(`\n#### spaceId = ${spaceId} ####`);
    await checkDept('Dev', spaceId);
    await checkDept('Migration', spaceId);
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
