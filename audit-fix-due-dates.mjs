// Audits/backfills stale Due Date values across every OPEN (not-done)
// ticket. Root cause (fixed going forward in commit 8836f0a): Due Date was
// only ever recomputed by startDeptSLA -- a department handoff or reopen --
// using whichever priority was set at THAT moment. Any ticket whose priority
// was edited afterward with no handoff following it kept its due date frozen
// at the OLD priority's goal, silently disagreeing with the SLA panel's own
// live, priority-driven countdown. This finds and corrects every one of
// those, using the exact same formula startDeptSLA/computeSlaGoalDurationMs
// already use (read straight from jira-pg-api.ts).
//
// For a ticket whose current department's SLA clock is 'running':
//   due = dept_sla_started_at + max(0, goalDuration(current priority) - elapsed_ms already logged)
// picking the EARLIEST due date across every active SLA policy that applies
// to that department (same "most urgent wins" rule as startDeptSLA).
//
// Tickets whose current department's clock is 'paused' or has no log entry
// at all are skipped and reported separately -- that's not the bug being
// fixed here (a paused clock isn't actively counting toward a due date the
// same way), and guessing a value for an unusual state risks writing
// something wrong rather than something merely stale.
//
// Usage:
//   node audit-fix-due-dates.mjs           # dry run, full report
//   node audit-fix-due-dates.mjs --apply   # writes the corrected due dates

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function deptMapGet(map, dept) {
  const key = Object.keys(map).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  return key ? map[key] : undefined;
}

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
    SELECT i.id, i.cf_key, i.key, i."spaceId", i.priority, i.current_department, i.dept_sla_log, i."dueDate", i."statusId"
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
  let skippedNotRunning = 0;
  let skippedNoPolicy = 0;

  for (const issue of issues) {
    const dept = issue.current_department;
    if (!dept) { skippedNotRunning++; continue; }
    const slaLog = issue.dept_sla_log || {};
    const entry = deptMapGet(slaLog, dept);
    if (!entry || entry.status !== 'running' || !entry.started_at) { skippedNotRunning++; continue; }

    const policies = (policiesBySpace.get(issue.spaceId) || []).filter((p) => {
      const pDept = (p.dept_name || '').trim().toLowerCase();
      return !pDept || pDept === dept.trim().toLowerCase();
    });
    if (!policies.length) { skippedNoPolicy++; continue; }

    const startedAt = new Date(entry.started_at).getTime();
    const priorElapsed = entry.elapsed_ms || 0;
    const priority = (issue.priority || 'medium').toLowerCase();

    let computedDue = null;
    for (const policy of policies) {
      const durationMs = computeSlaGoalDurationMs(policy, priority);
      const remainingMs = Math.max(0, durationMs - priorElapsed);
      const candidate = new Date(startedAt + remainingMs);
      if (!computedDue || candidate < computedDue) computedDue = candidate;
    }
    if (!computedDue) { skippedNoPolicy++; continue; }

    const storedDue = issue.dueDate ? new Date(issue.dueDate) : null;
    const diffMs = storedDue ? Math.abs(computedDue.getTime() - storedDue.getTime()) : Infinity;
    if (diffMs > MISMATCH_TOLERANCE_MS) {
      mismatches.push({
        id: issue.id, key: issue.cf_key || issue.key, dept, priority,
        stored: storedDue, computed: computedDue,
      });
    }
  }

  console.log(`\nFound ${mismatches.length} ticket(s) with a stale/wrong Due Date.`);
  console.log(`Skipped ${skippedNotRunning} (no running SLA clock for their current department -- not this bug).`);
  console.log(`Skipped ${skippedNoPolicy} (no applicable active SLA policy found).`);

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
