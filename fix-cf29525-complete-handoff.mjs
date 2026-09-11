// One-off correction for CF-29525. Confirmed via raw data: picking "Routed
// to Dev" from Migration's queue dropdown wrote dept_statuses["Migration"] =
// "Routed to Dev" (correct -- Migration's own outgoing record) but the
// actual department handoff (performDeptHandoff in jira-pg-api.ts) silently
// failed before the fix in commit 9a38e8a existed, leaving
// current_department stuck on "Migration" while everything downstream
// (Dev's dept_statuses restore, assignee restore, SLA pause/resume, real
// statusId sync, history, dept transition log, worked-on credit) never ran.
//
// This script finishes that handoff by hand, replicating performDeptHandoff/
// pauseDeptSLA/startDeptSLA's exact logic (read straight from
// src/lib/jira-pg-api.ts) against live queue config and SLA policy data --
// nothing here is guessed or hardcoded beyond "target department is Dev",
// which is what the ticket's own "Routed to Dev" label already says.
//
// Usage:
//   node fix-cf29525-complete-handoff.mjs           # dry run
//   node fix-cf29525-complete-handoff.mjs --apply   # writes the change

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const TICKET = 'CF-29525';
const TARGET_DEPT = 'Dev';

function deptMapGet(map, dept) {
  const key = Object.keys(map).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  return key ? map[key] : undefined;
}
function deptMapSet(map, dept, value) {
  const existingKey = Object.keys(map).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  map[existingKey || dept] = value;
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

async function main() {
  const { rows } = await pool.query(
    `SELECT id, "spaceId", current_department, "assigneeId", dept_statuses, dept_assignees,
            dept_sla_log, dept_sla_started_at, "statusId", priority
     FROM issues WHERE cf_key = $1`, [TICKET]
  );
  if (!rows.length) { console.log(`${TICKET} not found.`); await pool.end(); return; }
  const issue = rows[0];
  const oldDept = issue.current_department;
  if (oldDept.trim().toLowerCase() === TARGET_DEPT.toLowerCase()) {
    console.log(`${TICKET} is already in ${TARGET_DEPT}. Nothing to do.`);
    await pool.end();
    return;
  }

  const deptStatuses = issue.dept_statuses || {};
  const deptAssignees = issue.dept_assignees || {};
  const deptSlaLog = issue.dept_sla_log || {};

  // 1. Real status row behind the current global statusId, to determine isDoneNow.
  const { rows: curStatusRows } = await pool.query(`SELECT id, name, category, color FROM statuses WHERE id = $1`, [issue.statusId]);
  const priorStatus = curStatusRows[0] || null;
  const isDoneNow = priorStatus?.category === 'done';

  // 2. Restore (or leave unassigned if the saved user no longer exists) Dev's prior assignee.
  const savedForTarget = deptMapGet(deptAssignees, TARGET_DEPT);
  let handoffAssigneeId = null;
  let handoffAssigneeName = null;
  if (savedForTarget?.id) {
    const { rows: existsRows } = await pool.query(`SELECT 1 FROM users WHERE id = $1 LIMIT 1`, [savedForTarget.id]);
    if (existsRows.length) { handoffAssigneeId = savedForTarget.id; handoffAssigneeName = savedForTarget.displayName || null; }
  }
  if (!handoffAssigneeId) {
    console.log(`WARNING: no valid saved assignee found for ${TARGET_DEPT} -- ticket would land unassigned (no round-robin attempted by this script; round-robin state isn't safely reproducible outside the app). Re-run after checking manually if this looks wrong.`);
  }

  // 3. Old dept (Migration) snapshot: preserve as-is if it's already a routing label (it is: "Routed to Dev").
  const isRoutingLabel = (obj) => typeof obj?.id === 'string' && obj.id.startsWith('qst_') && /^(?:waiting\s+for|routed\s+to)\s+/i.test(String(obj?.name || ''));
  const existingOldDeptStatus = deptMapGet(deptStatuses, oldDept);
  let oldDeptStatusObj;
  if (isDoneNow) {
    oldDeptStatusObj = priorStatus
      ? { id: priorStatus.id, name: priorStatus.name, category: priorStatus.category, color: priorStatus.color }
      : { id: '', name: 'Unknown', category: 'todo', color: '#6B7280' };
  } else if (isRoutingLabel(existingOldDeptStatus)) {
    oldDeptStatusObj = existingOldDeptStatus; // unchanged -- already correct
  } else {
    oldDeptStatusObj = existingOldDeptStatus || { id: '', name: 'In Progress', category: 'in_progress', color: '#3B82F6' };
  }

  // 4. Target dept (Dev) snapshot.
  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, ['TESTIN']);
  const queues = cqRows[0]?.queues || [];
  const devQueue = queues.find((q) => String(q?.name || '').trim().toLowerCase() === TARGET_DEPT.toLowerCase());
  const targetQueueStatuses = devQueue?.queueStatuses || [];

  const targetOwnSnapshot = deptMapGet(deptStatuses, TARGET_DEPT);
  const restoringOwnSnapshot = isDoneNow && targetOwnSnapshot != null && !isRoutingLabel(targetOwnSnapshot);
  let newDeptStatusObj;
  let targetStatusId = issue.statusId; // fallback: leave unchanged if no real match found
  if (restoringOwnSnapshot) {
    newDeptStatusObj = targetOwnSnapshot;
    const { rows: realRows } = await pool.query(
      `SELECT id FROM statuses WHERE "spaceId" = $1 AND LOWER(name) = LOWER($2) ORDER BY "order" ASC LIMIT 1`,
      [issue.spaceId, newDeptStatusObj.name]
    );
    if (realRows[0]) targetStatusId = realRows[0].id;
  } else {
    const isReturningToDept = deptMapGet(deptStatuses, TARGET_DEPT) != null;
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
    const { rows: realRows } = await pool.query(
      `SELECT id FROM statuses WHERE "spaceId" = $1 AND LOWER(name) = LOWER($2) ORDER BY "order" ASC LIMIT 1`,
      [issue.spaceId, newDeptStatusObj.name]
    );
    if (realRows[0]) { targetStatusId = realRows[0].id; }
    else console.log(`WARNING: no real status row named "${newDeptStatusObj.name}" exists in this space -- leaving global statusId unchanged (${issue.statusId}) rather than writing an invalid/null value.`);
  }

  deptMapSet(deptStatuses, oldDept, oldDeptStatusObj);
  deptMapSet(deptStatuses, TARGET_DEPT, newDeptStatusObj);
  if (issue.assigneeId) deptMapSet(deptAssignees, oldDept, deptMapGet(deptAssignees, oldDept)); // already correctly saved; no-op

  // 5. SLA: pause oldDept (elapsed += now - dept_sla_started_at, since it was running), resume/start targetDept.
  const nowTs = new Date();
  const startedAt = issue.dept_sla_started_at ? new Date(issue.dept_sla_started_at) : null;
  const oldLogEntry = deptSlaLog[oldDept];
  const oldWasRunning = !oldLogEntry || oldLogEntry.status !== 'paused';
  const oldExistingElapsed = oldLogEntry?.elapsed_ms ?? 0;
  const oldNewElapsed = (oldWasRunning && startedAt) ? oldExistingElapsed + (nowTs.getTime() - startedAt.getTime()) : oldExistingElapsed;
  deptSlaLog[oldDept] = { ...(deptSlaLog[oldDept] || {}), started_at: startedAt?.toISOString() ?? nowTs.toISOString(), elapsed_ms: oldNewElapsed, paused_at: nowTs.toISOString(), status: 'paused' };

  const targetPriorElapsed = deptSlaLog[TARGET_DEPT]?.elapsed_ms ?? 0;
  deptSlaLog[TARGET_DEPT] = { ...(deptSlaLog[TARGET_DEPT] || {}), started_at: nowTs.toISOString(), elapsed_ms: targetPriorElapsed, status: 'running', paused_at: null };

  // dueDate: earliest remaining-budget deadline across applicable active SLA policies for Dev.
  let computedDueDate = null;
  try {
    const { rows: polRows } = await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`, [issue.spaceId]);
    const priority = (issue.priority || 'medium').toLowerCase();
    const applicable = polRows.filter((p) => {
      const pDept = (p.dept_name || '').trim().toLowerCase();
      return !pDept || pDept === TARGET_DEPT.toLowerCase();
    });
    for (const policy of applicable) {
      const durationMs = computeSlaGoalDurationMs(policy, priority);
      const remainingMs = Math.max(0, durationMs - targetPriorElapsed);
      const candidate = new Date(nowTs.getTime() + remainingMs);
      if (!computedDueDate || candidate < computedDueDate) computedDueDate = candidate;
    }
  } catch (e) { console.log('dueDate computation failed (non-fatal):', e.message); }

  console.log(`--- ${TICKET}: complete stuck handoff ${oldDept} -> ${TARGET_DEPT} ---`);
  console.log(`current_department: ${oldDept} -> ${TARGET_DEPT}`);
  console.log(`assigneeId: ${issue.assigneeId} -> ${handoffAssigneeId} (${handoffAssigneeName || 'unassigned'})`);
  console.log(`dept_statuses["${oldDept}"]: unchanged -> ${JSON.stringify(oldDeptStatusObj)}`);
  console.log(`dept_statuses["${TARGET_DEPT}"]: ${JSON.stringify(targetOwnSnapshot)} -> ${JSON.stringify(newDeptStatusObj)}`);
  console.log(`statusId: ${issue.statusId} -> ${targetStatusId}`);
  console.log(`dept_sla_log["${oldDept}"] -> ${JSON.stringify(deptSlaLog[oldDept])}`);
  console.log(`dept_sla_log["${TARGET_DEPT}"] -> ${JSON.stringify(deptSlaLog[TARGET_DEPT])}`);
  console.log(`dueDate -> ${computedDueDate ? computedDueDate.toISOString() : '(unchanged -- no applicable active SLA policy found for Dev)'}`);

  if (!APPLY) {
    console.log('\nDry run only -- no changes made. Re-run with --apply to write this change.');
    await pool.end();
    return;
  }

  await pool.query(
    `UPDATE issues SET current_department=$1, "assigneeId"=$2, dept_statuses=$3::jsonb, dept_assignees=$4::jsonb,
            dept_sla_log=$5::jsonb, dept_sla_started_at=NOW(), "statusId"=$6,
            "dueDate"=COALESCE($7, "dueDate"), "updatedAt"=NOW()
     WHERE id=$8`,
    [TARGET_DEPT, handoffAssigneeId, JSON.stringify(deptStatuses), JSON.stringify(deptAssignees),
     JSON.stringify(deptSlaLog), targetStatusId, computedDueDate ? computedDueDate.toISOString() : null, issue.id]
  );

  await pool.query(
    `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt")
     VALUES (gen_random_uuid()::text, $1, 'department', $2, $3, 'Manual data fix', 'bhanu.srikakulam@cloudfuze.com', NOW())`,
    [issue.id, oldDept, `${TARGET_DEPT} -- completed a "Routed to Dev" handoff that had silently failed server-side (fixed going forward in commit 9a38e8a)`]
  ).catch(() => {});
  if (issue.assigneeId !== handoffAssigneeId) {
    await pool.query(
      `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt")
       VALUES (gen_random_uuid()::text, $1, 'assignee', $2, $3, 'Manual data fix', 'bhanu.srikakulam@cloudfuze.com', NOW())`,
      [issue.id, deptMapGet(deptAssignees, oldDept)?.displayName || null, handoffAssigneeName]
    ).catch(() => {});
  }
  await pool.query(
    `INSERT INTO issue_dept_transitions (issue_id, space_id, from_dept, to_dept, moved_by, moved_at) VALUES ($1,$2,$3,$4,NULL,NOW()) ON CONFLICT DO NOTHING`,
    [issue.id, issue.spaceId, oldDept, TARGET_DEPT]
  ).catch(() => {});
  if (issue.assigneeId) {
    await pool.query(
      `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason) VALUES ($1,$2,$3,'passed') ON CONFLICT (user_id, issue_id, dept) DO UPDATE SET reason='passed', worked_at=NOW()`,
      [issue.assigneeId, issue.id, oldDept]
    ).catch(() => {});
  }

  console.log(`\nDone. ${TICKET} is now in ${TARGET_DEPT}.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
