// Backfill: compute the "Due Date" ticket property from each ticket's
// current-department SLA policy + priority, for EVERY ticket -- same
// priority-based goal duration the SLA panel already uses, applied to the
// separate `dueDate` column (sidebar/Filters/"Overdue" badge/export), which
// until now was a purely manual field with zero connection to the SLA
// policies configured per queue.
//
// Two different anchor formulas, matching computeSLAInstancesPure exactly:
//   - Still open:  dept_sla_started_at + max(0, goal - alreadyElapsedInDept)
//     (a live, forward-looking deadline from when this department's SLA
//     clock last started)
//   - Resolved:    resolvedAt + (goal - elapsedAtResolution)
//     (elapsedAtResolution already includes this final stint's own full
//     duration, folded in at resolve time -- anchoring to startedAt directly
//     here would double-count it and collapse the due date toward the start,
//     the exact bug already fixed for the SLA panel's own due time; see the
//     long comment in computeSLAInstancesPure)
// When more than one policy applies to a ticket's department, uses the
// EARLIEST (most urgent) resulting date, since the ticket property is a
// single value.
//
// DRY RUN BY DEFAULT -- only prints what would change. This can touch a
// large number of tickets and will OVERWRITE any existing manually-typed
// Due Date, so review the counts/sample before applying.
//
// Run ON the production server:
//   node --env-file=.env.server backfill-due-date-from-sla.mjs                # dry run, summary only
//   node --env-file=.env.server backfill-due-date-from-sla.mjs --sample 20    # dry run, show 20 example changes
//   node --env-file=.env.server backfill-due-date-from-sla.mjs --apply        # writes the changes

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const sampleIdx = process.argv.indexOf('--sample');
const SAMPLE_SIZE = sampleIdx !== -1 ? (parseInt(process.argv[sampleIdx + 1], 10) || 20) : 5;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function computeDurationMs(policy, priority) {
  let durationMs = 8 * 60 * 60 * 1000; // default 8h
  for (const goal of (policy.goals || [])) {
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
  return durationMs;
}

async function main() {
  const { rows: issues } = await pool.query(`
    SELECT id, key, cf_key, "spaceId", priority, current_department, "dueDate",
           dept_sla_started_at, dept_sla_log, "resolvedAt", "createdAt"
    FROM issues
    WHERE current_department IS NOT NULL AND current_department != ''
  `);
  console.log(`Scanning ${issues.length} tickets with a current department...`);

  const spaceIds = Array.from(new Set(issues.map((i) => i.spaceId).filter(Boolean)));
  const { rows: allPolicies } = await pool.query(
    `SELECT * FROM sla_definitions WHERE "spaceId" = ANY($1::text[]) AND status = 'active'`,
    [spaceIds]
  );
  const policiesBySpace = {};
  for (const p of allPolicies) (policiesBySpace[p.spaceId] ??= []).push(p);

  let noPolicy = 0, unchanged = 0, toChange = [];
  for (const issue of issues) {
    const dept = (issue.current_department || '').trim().toLowerCase();
    const priority = (issue.priority || 'medium').toLowerCase();
    const applicable = (policiesBySpace[issue.spaceId] || []).filter((p) => {
      const pDept = (p.dept_name || '').trim().toLowerCase();
      return !pDept || pDept === dept;
    });
    if (!applicable.length) { noPolicy++; continue; }

    const deptSlaLog = issue.dept_sla_log || {};
    const deptLogKey = Object.keys(deptSlaLog).find((k) => k.toLowerCase() === dept);
    const priorElapsedMs = deptLogKey ? (deptSlaLog[deptLogKey].elapsed_ms || 0) : 0;
    const isResolved = !!issue.resolvedAt;
    const startedAt = issue.dept_sla_started_at ? new Date(issue.dept_sla_started_at) : new Date(issue.createdAt);
    const resolvedAt = issue.resolvedAt ? new Date(issue.resolvedAt) : null;

    let computed = null;
    for (const policy of applicable) {
      const durationMs = computeDurationMs(policy, priority);
      const candidate = (isResolved && resolvedAt)
        ? new Date(resolvedAt.getTime() + (durationMs - priorElapsedMs))
        : new Date(startedAt.getTime() + Math.max(0, durationMs - priorElapsedMs));
      if (!computed || candidate < computed) computed = candidate;
    }
    if (!computed) { noPolicy++; continue; }

    const existing = issue.dueDate ? new Date(issue.dueDate) : null;
    // Compare at minute resolution -- avoids churning every row over
    // sub-minute float noise on a re-run.
    if (existing && Math.abs(existing.getTime() - computed.getTime()) < 60_000) { unchanged++; continue; }

    toChange.push({ id: issue.id, key: issue.cf_key || issue.key, oldDueDate: issue.dueDate, newDueDate: computed });
  }

  console.log(`\nSummary:`);
  console.log(`  No applicable SLA policy (left alone): ${noPolicy}`);
  console.log(`  Already correct:                       ${unchanged}`);
  console.log(`  Would change:                          ${toChange.length}`);

  if (toChange.length) {
    console.log(`\nSample of changes (showing ${Math.min(SAMPLE_SIZE, toChange.length)} of ${toChange.length}):`);
    for (const c of toChange.slice(0, SAMPLE_SIZE)) {
      console.log(`  ${c.key}: ${c.oldDueDate ?? '(none)'} -> ${c.newDueDate.toISOString()}`);
    }
  }

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to write ${toChange.length} change${toChange.length === 1 ? '' : 's'}.`);
    await pool.end();
    return;
  }

  if (!toChange.length) {
    console.log('\nNothing to apply.');
    await pool.end();
    return;
  }

  let written = 0;
  for (const c of toChange) {
    await pool.query(`UPDATE issues SET "dueDate" = $1, "updatedAt" = NOW() WHERE id = $2`, [c.newDueDate.toISOString(), c.id]);
    written++;
  }
  console.log(`\nUpdated dueDate on ${written} ticket${written === 1 ? '' : 's'}.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
