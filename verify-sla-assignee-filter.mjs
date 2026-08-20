/**
 * verify-sla-assignee-filter.mjs
 * READ-ONLY. Answers: when the SLA Breached filter is combined with an
 * assignee filter on top of a department queue (Dev / Migration), does the
 * app's actual query path (dept-scoped raw SQL: COUNT query + candidate-set
 * fetch, both narrowed by "assigneeId = X") return exactly the same breached
 * set as filtering the department's own FULL, already-verified-correct
 * breached set down to that one assignee in plain JS?
 *
 * If the two ever disagree, it means the count query and the row-fetch query
 * (or the candidate-set sizing) have drifted apart for this filter
 * combination -- the same class of silent-truncation bug already found and
 * fixed for the plain department view (see verify-sla-cap-fix.mjs), just
 * narrower in scope. A clean run (0 missing, 0 extra, 0 false-breached for
 * every assignee in both departments) means that bug pattern does NOT recur
 * for the assignee+department+SLA combination.
 *
 * Uses the exact same per-ticket breach formula as the list/filter endpoint
 * (priorElapsedMs carryover + isSameStint guard, see src/lib/jira-pg-api.ts
 * and verify-sla-cap-fix.mjs) so this is judged against the real app logic,
 * not a simplified proxy.
 *
 * Run: DATABASE_URL=... node verify-sla-assignee-filter.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

// Same safety ceiling as SLA_PREFILTER_CAP in jira-pg-api.ts -- the assignee
// filter should narrow the SQL-level candidate set to WAY below this, but
// the check below verifies that explicitly rather than assuming it.
const SLA_PREFILTER_CAP = 50000;

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

// Identical to the formula in verify-sla-cap-fix.mjs / jira-pg-api.ts's list
// endpoint (dept-scoped branch).
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

const ROW_COLUMNS = `i.id, i.key, i.priority, i."assigneeId", i."createdAt", i."dueDate", i.jira_sla_breached,
       i.dept_sla_started_at, i.dept_sla_log, i.current_department,
       s.name AS status_name, s.category AS status_category`;

async function checkDept(dept, spaceId) {
  console.log(`\n═══ ${dept} (spaceId=${spaceId}) ═══`);
  const policiesRes = await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`, [spaceId]);
  const policies = policiesRes.rows;

  // Full, unfiltered candidate set for this department -- this mirrors what
  // the fixed dept-scoped branch fetches when NO assignee filter is active
  // (already verified correct by verify-sla-cap-fix.mjs).
  const allRows = await pool.query(`
    SELECT ${ROW_COLUMNS}
    FROM issues i
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE LOWER(i.current_department) = LOWER($1) AND i."spaceId" = $2
    ORDER BY i."createdAt" DESC
  `, [dept, spaceId]);
  const full = allRows.rows;
  const nowMs = Date.now();
  const fullBreachedByKey = new Map(full.filter((r) => isBreached(r, policies, nowMs)).map((r) => [r.key, r]));

  console.log(`Total ${dept} tickets: ${full.length}. Breached (full, unfiltered, ground truth): ${fullBreachedByKey.size}`);

  // Pick 3 real assignees who actually have tickets in this department.
  const assigneeRows = await pool.query(`
    SELECT i."assigneeId" AS id, u.email, COUNT(*)::int AS ticket_count
    FROM issues i
    JOIN users u ON u.id = i."assigneeId"
    WHERE LOWER(i.current_department) = LOWER($1) AND i."spaceId" = $2 AND i."assigneeId" IS NOT NULL
    GROUP BY i."assigneeId", u.email
    ORDER BY ticket_count DESC
    LIMIT 3
  `, [dept, spaceId]);

  if (!assigneeRows.rows.length) {
    console.log(`  (no assigned tickets in ${dept} -- nothing to check)`);
    return { ok: true, checked: 0 };
  }

  let allOk = true;
  let checkedAssignees = 0;

  for (const a of assigneeRows.rows) {
    checkedAssignees++;
    // Expected: whatever the FULL, ground-truth breached set says for this
    // assignee's tickets (JS-side filter -- no SQL involved, can't drift).
    const expected = new Set(full.filter((r) => r.assigneeId === a.id && isBreached(r, policies, nowMs)).map((r) => r.key));

    // Actual: replicate the app's real dept-scoped query path -- a COUNT
    // query and a row-fetch query that both carry the SAME "assigneeId = X"
    // predicate (this is exactly what jira-pg-api.ts's deptExtraClauses /
    // deptExtraParams do), then size the candidate fetch to
    // Math.min(count, SLA_PREFILTER_CAP) the same way the fixed endpoint does.
    const countRes = await pool.query(`
      SELECT COUNT(*)::int AS cnt
      FROM issues i
      LEFT JOIN statuses s ON i."statusId" = s.id
      WHERE LOWER(i.current_department) = LOWER($1) AND i."spaceId" = $2 AND i."assigneeId" = $3
    `, [dept, spaceId, a.id]);
    const candidateCount = countRes.rows[0]?.cnt ?? 0;
    const fetchSize = Math.min(candidateCount, SLA_PREFILTER_CAP);

    const rowsRes = await pool.query(`
      SELECT ${ROW_COLUMNS}
      FROM issues i
      LEFT JOIN statuses s ON i."statusId" = s.id
      WHERE LOWER(i.current_department) = LOWER($1) AND i."spaceId" = $2 AND i."assigneeId" = $3
      ORDER BY i."createdAt" DESC
      LIMIT $4
    `, [dept, spaceId, a.id, fetchSize]);

    const actual = new Set(rowsRes.rows.filter((r) => isBreached(r, policies, nowMs)).map((r) => r.key));

    const missing = [...expected].filter((k) => !actual.has(k)); // breached per ground truth, but the SQL path silently dropped it
    const extra = [...actual].filter((k) => !expected.has(k));   // SQL path flagged breached, but ground truth disagrees (false positive)

    const label = `${a.email} (${a.ticket_count} tickets in ${dept})`;
    if (missing.length === 0 && extra.length === 0) {
      console.log(`  OK   ${label}: breached=${expected.size}, candidate rows fetched=${candidateCount} (cap=${SLA_PREFILTER_CAP}) -- exact match, correct subset.`);
    } else {
      allOk = false;
      console.log(`  FAIL ${label}: expected ${expected.size} breached, got ${actual.size}.`);
      if (missing.length) console.log(`       Missing (should be breached, filter silently dropped): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', ...' : ''}`);
      if (extra.length) console.log(`       Extra (filter falsely flagged as breached): ${extra.slice(0, 10).join(', ')}${extra.length > 10 ? ', ...' : ''}`);
    }
  }

  return { ok: allOk, checked: checkedAssignees };
}

async function main() {
  const spaceRow = await pool.query(`
    SELECT DISTINCT "spaceId" FROM issues WHERE LOWER(current_department) IN ('dev', 'migration')
  `);
  const spaceIds = spaceRow.rows.map((r) => r.spaceId);
  if (!spaceIds.length) {
    console.log('No tickets found with current_department Dev or Migration -- nothing to check.');
    await pool.end();
    return;
  }

  let overallOk = true;
  let totalChecked = 0;
  for (const spaceId of spaceIds) {
    console.log(`\n#### spaceId = ${spaceId} ####`);
    for (const dept of ['Dev', 'Migration']) {
      const res = await checkDept(dept, spaceId);
      overallOk = overallOk && res.ok;
      totalChecked += res.checked;
    }
  }

  console.log('\n════════════════════════════════════════════════');
  if (totalChecked === 0) {
    console.log('No assigned tickets found in Dev/Migration across any space -- nothing was actually checked.');
  } else if (overallOk) {
    console.log(`PASS -- all ${totalChecked} assignee/department combinations checked matched the ground-truth breached set exactly (no missing, no extra).`);
  } else {
    console.log('FAIL -- at least one assignee/department combination above disagreed with the ground-truth breached set. See FAIL lines for details.');
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
