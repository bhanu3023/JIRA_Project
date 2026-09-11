// Audits/backfills stale Due Date values on every OPEN (not-done) ticket.
//
// Due date model (per explicit request, matching what computeSLAInstancesPure
// and startDeptSLA now both use): dueDate = createdAt + priority's goal
// duration for whichever active SLA policy applies to the ticket's current
// department (earliest/most-urgent across multiple applicable policies).
// This replaced an earlier per-department elapsed/pause-based model --
// confirmed for real on CF-29525 that the old model could compute a due
// date wildly inconsistent with the ticket's own displayed creation-based
// Start time (a "1 day" SLA showing a 25-day span).
//
// Usage:
//   node audit-fix-due-dates.mjs           # dry run, full report
//   node audit-fix-due-dates.mjs --apply   # writes the corrected due dates

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function computeSlaGoalDurationMs(policy, priority) {
  let durationMs = 8 * 60 * 60 * 1000;
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

const MISMATCH_TOLERANCE_MS = 60_000; // ignore sub-minute float/precision noise

async function main() {
  const { rows: issues } = await pool.query(`
    SELECT i.id, i.cf_key, i.key, i."spaceId", i.priority, i.current_department, i."createdAt", i."dueDate", i."statusId"
    FROM issues i
    LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE s.category IS DISTINCT FROM 'done'
  `);
  const { rows: policyRows } = await pool.query(`SELECT * FROM sla_definitions WHERE status = 'active'`);
  const policiesBySpace = new Map();
  for (const p of policyRows) {
    if (!policiesBySpace.has(p.spaceId)) policiesBySpace.set(p.spaceId, []);
    policiesBySpace.get(p.spaceId).push(p);
  }

  console.log(`Scanning ${issues.length} open (not-done) issues...`);

  const mismatches = [];
  let skippedNoPolicy = 0;

  for (const issue of issues) {
    const dept = (issue.current_department || '').trim().toLowerCase();
    const policies = (policiesBySpace.get(issue.spaceId) || []).filter((p) => {
      const pDept = (p.dept_name || '').trim().toLowerCase();
      return !pDept || pDept === dept;
    });
    if (!policies.length) { skippedNoPolicy++; continue; }

    const createdAt = new Date(issue.createdAt).getTime();
    const priority = (issue.priority || 'medium').toLowerCase();

    let computedDue = null;
    for (const policy of policies) {
      const durationMs = computeSlaGoalDurationMs(policy, priority);
      const candidate = new Date(createdAt + durationMs);
      if (!computedDue || candidate < computedDue) computedDue = candidate;
    }
    if (!computedDue) { skippedNoPolicy++; continue; }

    const storedDue = issue.dueDate ? new Date(issue.dueDate) : null;
    const diffMs = storedDue ? Math.abs(computedDue.getTime() - storedDue.getTime()) : Infinity;
    if (diffMs > MISMATCH_TOLERANCE_MS) {
      mismatches.push({
        id: issue.id, key: issue.cf_key || issue.key, dept: issue.current_department, priority,
        stored: storedDue, computed: computedDue,
      });
    }
  }

  console.log(`\nFound ${mismatches.length} ticket(s) with a stale/wrong Due Date.`);
  console.log(`Skipped ${skippedNoPolicy} (no applicable active SLA policy found for their current department).`);

  console.log(`\nSample (first 25):`);
  for (const m of mismatches.slice(0, 25)) {
    console.log(`  ${m.key} [${m.dept}, ${m.priority}]: ${m.stored ? m.stored.toISOString() : 'null'} -> ${m.computed.toISOString()}`);
  }
  if (mismatches.length > 25) console.log(`  ... and ${mismatches.length - 25} more.`);

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to write these ${mismatches.length} correction(s).`);
    await pool.end();
    return;
  }

  let written = 0;
  for (const m of mismatches) {
    await pool.query(`UPDATE issues SET "dueDate"=$1, "updatedAt"=NOW() WHERE id=$2`, [m.computed.toISOString(), m.id]);
    written++;
    if (written % 500 === 0) console.log(`  ...${written}/${mismatches.length}`);
  }
  console.log(`\nCorrected ${written} due date(s).`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
