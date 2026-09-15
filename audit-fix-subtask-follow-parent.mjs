// Aligns every subtask's department with its PARENT's CURRENT department --
// supersedes audit-fix-subtask-department-drift.mjs's premise (which
// restored a subtask to original_dept, its creation-time snapshot). That was
// correct under the initial interpretation of the lock fix (7800895), but
// after clarifying directly with the user: a subtask should follow wherever
// its parent currently is, not freeze at whichever department happened to
// own the parent the moment the subtask was created. 2ea533c adds that as
// the ongoing behavior for every FUTURE department move (parent moving now
// cascades to its subtasks); this is the one-off catch-up for tickets that
// drifted or were created before that existed.
//
// Same status-carrying rule as the app's own cascadeDeptToChildren: only WHO
// owns a subtask moves to match the parent -- its own current work status
// (Open/In Progress/Resolved) carries over to the new department key rather
// than resetting, and a stale "Waiting for X"/"Routed to X" leftover is
// replaced with a real status instead of carried forward.
//
// Usage:
//   node audit-fix-subtask-follow-parent.mjs           # dry run, full report
//   node audit-fix-subtask-follow-parent.mjs --apply   # writes the corrections

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ROUTING_LABEL = /^(?:waiting\s+for|routed\s+to)\s+/i;

function deptMapGet(map, dept) {
  if (!dept) return undefined;
  const key = Object.keys(map || {}).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  return key ? map[key] : undefined;
}

async function main() {
  console.log("Scanning subtasks whose department doesn't match their parent's current department...");
  const { rows: subtasks } = await pool.query(`
    SELECT c.id, c.cf_key, c.key, c."parentKey", c.current_department AS child_dept,
           c.dept_statuses AS child_dept_statuses, c."spaceId",
           p.cf_key AS parent_cf_key, p.summary AS parent_summary, p.current_department AS parent_dept
    FROM issues c
    JOIN issues p ON p.key = c."parentKey"
    WHERE c."parentKey" IS NOT NULL
      AND p.current_department IS NOT NULL AND p.current_department <> ''
      AND (c.current_department IS NULL OR c.current_department = '' OR LOWER(c.current_department) <> LOWER(p.current_department))
  `);
  console.log(`Found ${subtasks.length} subtask(s) out of sync with their parent.\n`);
  if (!subtasks.length) { await pool.end(); return; }

  const { rows: queueRows } = await pool.query(`SELECT queues FROM custom_queues`);
  const queueStatusesFor = (deptName) => {
    for (const row of queueRows) {
      const queues = row.queues || [];
      const q = queues.find((qq) => (qq.name || '').toLowerCase() === deptName.toLowerCase());
      if (q?.queueStatuses?.length) return q.queueStatuses;
    }
    return [];
  };

  const plan = subtasks.map((s) => {
    const childOwnStatus = deptMapGet(s.child_dept_statuses || {}, s.child_dept);
    const isStale = childOwnStatus && ROUTING_LABEL.test((childOwnStatus.name || '').trim());
    const newDeptStatuses = { ...(s.child_dept_statuses || {}) };
    let newStatusName = null;
    if (childOwnStatus && !isStale) {
      newDeptStatuses[s.parent_dept] = childOwnStatus;
    } else {
      const targetQueueStatuses = queueStatusesFor(s.parent_dept);
      const fallback = targetQueueStatuses.find((x) => x.category === 'in_progress')
        || targetQueueStatuses.find((x) => x.category === 'todo')
        || targetQueueStatuses[0];
      if (fallback) {
        newStatusName = fallback.name;
        newDeptStatuses[s.parent_dept] = { id: fallback.id, name: fallback.name, color: fallback.color || '#64748B', category: fallback.category || 'in_progress' };
      }
    }
    return {
      id: s.id, key: s.cf_key || s.key,
      parentKey: s.parent_cf_key, parentSummary: s.parent_summary,
      childDept: s.child_dept || '(none)', parentDept: s.parent_dept,
      newDeptStatuses, newStatusName, carried: !!(childOwnStatus && !isStale),
    };
  });

  console.log('Plan:');
  for (const p of plan) {
    const note = p.carried ? ' | status carried over as-is' : (p.newStatusName ? ` | status set to "${p.newStatusName}"` : ' | no queue default found -- status left untouched');
    console.log(`  ${p.key} (under ${p.parentKey} "${p.parentSummary}"): ${p.childDept} -> ${p.parentDept}${note}`);
  }

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to write these ${plan.length} correction(s).`);
    await pool.end();
    return;
  }

  let written = 0;
  for (const p of plan) {
    await pool.query(
      `UPDATE issues SET current_department=$1, original_dept=$1, dept_statuses=$2::jsonb, dept_sla_started_at=NOW(), "updatedAt"=NOW() WHERE id=$3`,
      [p.parentDept, JSON.stringify(p.newDeptStatuses), p.id]
    );
    written++;
  }
  console.log(`\nAligned ${written} subtask(s) with their parent's current department.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
