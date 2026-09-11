// Repairs tickets stuck in the exact half-state confirmed on CF-29525 and
// CF-23245: current_department's OWN dept_statuses snapshot is itself a
// "Routed to X" / "Waiting for X" routing label naming a DIFFERENT
// department -- meaning the department genuinely tried to route this ticket
// away, the status change committed, but the actual handoff
// (performDeptHandoff) silently failed before the fixes in 9a38e8a and
// 9e513c3 existed. The ticket never actually left; only the label claiming
// it did stuck around.
//
// Detection: for each issue, look up dept_statuses[current_department]. If
// that entry's name matches "Routed to X"/"Waiting for X" and X is a real,
// different department (not current_department itself), it's stuck.
//
// Repair replicates performDeptHandoff/pauseDeptSLA/startDeptSLA's exact
// logic by hand (same approach as the original CF-29525 one-off script),
// against live queue config and SLA policy data -- nothing hardcoded beyond
// what each ticket's own routing label says its destination should be.
//
// Usage:
//   node complete-stuck-handoffs.mjs                  # scan + dry run every stuck ticket
//   node complete-stuck-handoffs.mjs CF-23245          # scan + dry run just one ticket
//   node complete-stuck-handoffs.mjs --apply           # scan + fix every stuck ticket
//   node complete-stuck-handoffs.mjs CF-23245 --apply  # fix just one ticket

import pg from 'pg';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY_KEY = args.find((a) => !a.startsWith('--'));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function deptMapGet(map, dept) {
  const key = Object.keys(map).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  return key ? map[key] : undefined;
}
function deptMapSet(map, dept, value) {
  const existingKey = Object.keys(map).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  map[existingKey || dept] = value;
}
function isRoutingLabel(obj) {
  return typeof obj?.id === 'string' && obj.id.startsWith('qst_') && /^(?:waiting\s+for|routed\s+to)\s+/i.test(String(obj?.name || ''));
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

async function findStuckTickets() {
  const { rows } = await pool.query(`
    SELECT id, cf_key, key, "spaceId", current_department, dept_statuses
    FROM issues
    WHERE dept_statuses IS NOT NULL AND dept_statuses != '{}'::jsonb AND current_department IS NOT NULL
    ${ONLY_KEY ? `AND (cf_key = $1 OR key = $1)` : ''}
  `, ONLY_KEY ? [ONLY_KEY] : []);

  const stuck = [];
  for (const row of rows) {
    const dept = row.current_department;
    const deptStatuses = row.dept_statuses || {};
    const ownSnapshot = deptMapGet(deptStatuses, dept);
    if (!isRoutingLabel(ownSnapshot)) continue;
    const m = String(ownSnapshot.name || '').match(/^(?:waiting\s+for|routed\s+to)\s+(.+)$/i);
    if (!m) continue;
    const targetDept = m[1].trim();
    if (targetDept.toLowerCase() === dept.trim().toLowerCase()) continue; // routed to itself -- not stuck
    stuck.push({ id: row.id, key: row.cf_key || row.key, spaceId: row.spaceId, oldDept: dept, targetDept });
  }
  return stuck;
}

async function completeHandoff(ticket) {
  const { id: issueId, key, spaceId, oldDept, targetDept } = ticket;
  const { rows } = await pool.query(
    `SELECT current_department, "assigneeId", dept_statuses, dept_assignees,
            dept_sla_log, dept_sla_started_at, "statusId", priority
     FROM issues WHERE id = $1`, [issueId]
  );
  const issue = rows[0];
  if (!issue || issue.current_department.trim().toLowerCase() !== oldDept.trim().toLowerCase()) {
    return { key, skipped: true, reason: 'department already changed since scan -- re-run to re-check' };
  }

  const deptStatuses = issue.dept_statuses || {};
  const deptAssignees = issue.dept_assignees || {};
  const deptSlaLog = issue.dept_sla_log || {};

  const { rows: curStatusRows } = await pool.query(`SELECT category FROM statuses WHERE id = $1`, [issue.statusId]);
  const isDoneNow = curStatusRows[0]?.category === 'done';

  const savedForTarget = deptMapGet(deptAssignees, targetDept);
  let handoffAssigneeId = null, handoffAssigneeName = null;
  if (savedForTarget?.id) {
    const { rows: existsRows } = await pool.query(`SELECT 1 FROM users WHERE id = $1 LIMIT 1`, [savedForTarget.id]);
    if (existsRows.length) { handoffAssigneeId = savedForTarget.id; handoffAssigneeName = savedForTarget.displayName || null; }
  }

  const existingOldDeptStatus = deptMapGet(deptStatuses, oldDept);
  let oldDeptStatusObj = isDoneNow || !isRoutingLabel(existingOldDeptStatus)
    ? (existingOldDeptStatus || { id: '', name: 'In Progress', category: 'in_progress', color: '#3B82F6' })
    : existingOldDeptStatus;

  const { rows: cqRows } = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  const findDeptQueueStatuses = (deptName) => {
    for (const r of cqRows) {
      const queues = r.queues || [];
      const q = queues.find((qq) => String(qq?.name || '').trim().toLowerCase() === deptName.toLowerCase());
      if (q?.queueStatuses?.length) return q.queueStatuses;
    }
    return [];
  };
  const targetQueueStatuses = findDeptQueueStatuses(targetDept);

  const targetOwnSnapshot = deptMapGet(deptStatuses, targetDept);
  const restoringOwnSnapshot = isDoneNow && targetOwnSnapshot != null && !isRoutingLabel(targetOwnSnapshot);
  let newDeptStatusObj, targetStatusId = issue.statusId;
  if (restoringOwnSnapshot) {
    newDeptStatusObj = targetOwnSnapshot;
  } else {
    const isReturningToDept = deptMapGet(deptStatuses, targetDept) != null;
    if (isDoneNow || isReturningToDept) {
      const inProgressSt = targetQueueStatuses.find((s) => s.category === 'in_progress')
        || targetQueueStatuses.find((s) => (s.name || '').toLowerCase().includes('progress'));
      newDeptStatusObj = inProgressSt
        ? { id: inProgressSt.id, name: inProgressSt.name, category: inProgressSt.category, color: inProgressSt.color }
        : { id: '', name: 'In Progress', category: 'in_progress', color: '#3B82F6' };
    } else {
      const firstTodoSt = targetQueueStatuses.find((s) => s.category === 'todo') || targetQueueStatuses[0];
      newDeptStatusObj = firstTodoSt
        ? { id: firstTodoSt.id, name: firstTodoSt.name, category: firstTodoSt.category, color: firstTodoSt.color }
        : { id: '', name: 'Open', category: 'todo', color: '#6366F1' };
    }
  }
  const { rows: realRows } = await pool.query(
    `SELECT id FROM statuses WHERE "spaceId" = $1 AND LOWER(name) = LOWER($2) ORDER BY "order" ASC LIMIT 1`,
    [spaceId, newDeptStatusObj.name]
  );
  if (realRows[0]) targetStatusId = realRows[0].id;

  deptMapSet(deptStatuses, oldDept, oldDeptStatusObj);
  deptMapSet(deptStatuses, targetDept, newDeptStatusObj);

  const nowTs = new Date();
  const startedAt = issue.dept_sla_started_at ? new Date(issue.dept_sla_started_at) : null;
  const oldLogEntry = deptSlaLog[oldDept];
  const oldWasRunning = !oldLogEntry || oldLogEntry.status !== 'paused';
  const oldExistingElapsed = oldLogEntry?.elapsed_ms ?? 0;
  const oldNewElapsed = (oldWasRunning && startedAt) ? oldExistingElapsed + (nowTs.getTime() - startedAt.getTime()) : oldExistingElapsed;
  deptSlaLog[oldDept] = { ...(deptSlaLog[oldDept] || {}), started_at: startedAt?.toISOString() ?? nowTs.toISOString(), elapsed_ms: oldNewElapsed, paused_at: nowTs.toISOString(), status: 'paused' };

  const targetPriorElapsed = deptSlaLog[targetDept]?.elapsed_ms ?? 0;
  deptSlaLog[targetDept] = { ...(deptSlaLog[targetDept] || {}), started_at: nowTs.toISOString(), elapsed_ms: targetPriorElapsed, status: 'running', paused_at: null };

  let computedDueDate = null;
  try {
    const { rows: polRows } = await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`, [spaceId]);
    const priority = (issue.priority || 'medium').toLowerCase();
    const applicable = polRows.filter((p) => {
      const pDept = (p.dept_name || '').trim().toLowerCase();
      return !pDept || pDept === targetDept.toLowerCase();
    });
    for (const policy of applicable) {
      const durationMs = computeSlaGoalDurationMs(policy, priority);
      const remainingMs = Math.max(0, durationMs - targetPriorElapsed);
      const candidate = new Date(nowTs.getTime() + remainingMs);
      if (!computedDueDate || candidate < computedDueDate) computedDueDate = candidate;
    }
  } catch {}

  const summary = {
    key, oldDept, targetDept,
    assignee: `${issue.assigneeId} -> ${handoffAssigneeId} (${handoffAssigneeName || 'unassigned'})`,
    oldDeptStatus: oldDeptStatusObj, newDeptStatus: newDeptStatusObj,
    statusId: `${issue.statusId} -> ${targetStatusId}`,
    dueDate: computedDueDate ? computedDueDate.toISOString() : null,
  };

  if (APPLY) {
    await pool.query(
      `UPDATE issues SET current_department=$1, "assigneeId"=$2, dept_statuses=$3::jsonb, dept_assignees=$4::jsonb,
              dept_sla_log=$5::jsonb, dept_sla_started_at=NOW(), "statusId"=$6,
              "dueDate"=COALESCE($7, "dueDate"), "updatedAt"=NOW()
       WHERE id=$8`,
      [targetDept, handoffAssigneeId, JSON.stringify(deptStatuses), JSON.stringify(deptAssignees),
       JSON.stringify(deptSlaLog), targetStatusId, computedDueDate ? computedDueDate.toISOString() : null, issueId]
    );
    await pool.query(
      `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt")
       VALUES (gen_random_uuid()::text, $1, 'department', $2, $3, 'Manual data fix', 'bhanu.srikakulam@cloudfuze.com', NOW())`,
      [issueId, oldDept, `${targetDept} -- completed a "Routed to ${targetDept}" handoff that had silently failed server-side (fixed going forward in 9a38e8a / 9e513c3)`]
    ).catch(() => {});
    if (issue.assigneeId !== handoffAssigneeId) {
      await pool.query(
        `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt")
         VALUES (gen_random_uuid()::text, $1, 'assignee', $2, $3, 'Manual data fix', 'bhanu.srikakulam@cloudfuze.com', NOW())`,
        [issueId, deptMapGet(deptAssignees, oldDept)?.displayName || null, handoffAssigneeName]
      ).catch(() => {});
    }
    await pool.query(
      `INSERT INTO issue_dept_transitions (issue_id, space_id, from_dept, to_dept, moved_by, moved_at) VALUES ($1,$2,$3,$4,NULL,NOW()) ON CONFLICT DO NOTHING`,
      [issueId, spaceId, oldDept, targetDept]
    ).catch(() => {});
    if (issue.assigneeId) {
      await pool.query(
        `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason) VALUES ($1,$2,$3,'passed') ON CONFLICT (user_id, issue_id, dept) DO UPDATE SET reason='passed', worked_at=NOW()`,
        [issue.assigneeId, issueId, oldDept]
      ).catch(() => {});
    }
  }

  return summary;
}

async function main() {
  const stuck = await findStuckTickets();
  if (ONLY_KEY && !stuck.length) {
    console.log(`${ONLY_KEY} is not stuck (or not found) -- nothing to do.`);
    await pool.end();
    return;
  }
  console.log(`Found ${stuck.length} stuck ticket(s)${ONLY_KEY ? '' : ' across the whole database'}.`);
  for (const t of stuck) console.log(`  ${t.key}: stuck in ${t.oldDept}, labeled "Routed to ${t.targetDept}"`);

  console.log(`\n--- ${APPLY ? 'Applying' : 'Dry run'} ---\n`);
  for (const t of stuck) {
    const result = await completeHandoff(t);
    if (result.skipped) {
      console.log(`${result.key}: SKIPPED -- ${result.reason}`);
      continue;
    }
    console.log(`${result.key}: ${result.oldDept} -> ${result.targetDept}`);
    console.log(`  assignee: ${result.assignee}`);
    console.log(`  dept_statuses["${result.oldDept}"]: unchanged -> ${JSON.stringify(result.oldDeptStatus)}`);
    console.log(`  dept_statuses["${result.targetDept}"]: -> ${JSON.stringify(result.newDeptStatus)}`);
    console.log(`  statusId: ${result.statusId}`);
    console.log(`  dueDate: -> ${result.dueDate || '(unchanged)'}`);
  }

  if (!APPLY) console.log(`\nDry run only -- no changes made. Re-run with --apply to write these ${stuck.length} correction(s).`);
  else console.log(`\nApplied ${stuck.length} correction(s).`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
