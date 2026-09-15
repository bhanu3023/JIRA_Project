// Fixes subtasks that drifted away from their creating department --
// fallout from the missing subtask-lock in the department-handoff code,
// fixed in 7800895 (a subtask's own "Waiting for X" status pick used to
// trigger the same performDeptHandoff as a real ticket, moving it to
// another department entirely independent of its parent).
//
// original_dept is set once at issue creation and never touched by any
// handoff/transfer code afterward (confirmed: the /department PATCH
// endpoint only ever writes it via COALESCE(original_dept, $new), so an
// already-set value is never overwritten) -- it's the reliable record of
// which team a subtask was actually created for, regardless of how many
// times current_department has since moved.
//
// Confirmed for real (CF-32993): the lock fix stops the DEPARTMENT from
// moving, but a "Waiting for X"/"Routed to X" pick made just before that
// fix deployed already wrote its literal text into dept_statuses -- the
// ticket was left frozen showing "ROUTED TO QA" forever while Department
// stayed on "Dev", since nothing ever un-routes a status label once it's
// written. This script cleans that up too, not just the department.
//
// For each drifted subtask:
//   - current_department is restored to original_dept
//   - if a saved dept_assignees[original_dept] entry exists (and that user
//     still exists), the assignee is restored to match -- same safety
//     check performDeptHandoff itself applies on restore. Otherwise the
//     assignee is left alone (no guessing/round-robin here).
//   - dept_sla_started_at is reset to NOW() for the restored department.
//   - if the ticket's status (real or any dept_statuses entry) is a
//     "Waiting for X"/"Routed to X" routing label -- a transitional state
//     that was never supposed to be permanent -- it's replaced with the
//     restored department's own queue default (its "In Progress" entry if
//     the ticket had already been worked on per its category, else its
//     "Open"/todo entry), and dept_statuses is collapsed down to just that
//     one department (subtasks don't keep multi-department history going
//     forward, since they never really leave their department now).
//
// Usage:
//   node audit-fix-subtask-department-drift.mjs           # dry run, full report
//   node audit-fix-subtask-department-drift.mjs --apply   # writes the corrections

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
  console.log('Scanning subtasks whose current_department has drifted from original_dept...');
  const { rows: drifted } = await pool.query(`
    SELECT id, cf_key, key, "parentKey", current_department, original_dept,
           "assigneeId", dept_assignees, dept_statuses, "statusId", "spaceId"
    FROM issues
    WHERE "parentKey" IS NOT NULL
      AND original_dept IS NOT NULL AND original_dept <> ''
      AND current_department IS NOT NULL AND current_department <> ''
      AND (
        -- Department itself still drifted.
        LOWER(current_department) <> LOWER(original_dept)
        -- Or department is already correct (e.g. a previous --apply run
        -- already fixed it) but a stale "Waiting for X"/"Routed to X" label
        -- is still parked under that department's own dept_statuses entry
        -- from before the lock fix existed -- confirmed for real: CF-32993
        -- had one such leftover under EVERY department it ever visited,
        -- including the correct one (Infra), so restoring current_department
        -- alone surfaced a different stale label than the one it started
        -- with instead of a clean status.
        OR (
          dept_statuses IS NOT NULL
          AND jsonb_typeof(dept_statuses -> current_department) = 'object'
          AND (dept_statuses -> current_department ->> 'name') ~* '^(waiting\\s+for|routed\\s+to)\\s+'
        )
      )
  `);
  console.log(`Found ${drifted.length} affected subtask(s).\n`);
  if (!drifted.length) { await pool.end(); return; }

  const parentKeys = [...new Set(drifted.map((d) => d.parentKey))];
  const { rows: parents } = await pool.query(
    `SELECT key, cf_key, summary FROM issues WHERE key = ANY($1::text[])`,
    [parentKeys]
  );
  const parentMap = new Map(parents.map((p) => [p.key, p]));

  const { rows: statusRows } = await pool.query(`SELECT id, name, color, category, "spaceId" FROM statuses`);
  const { rows: queueRows } = await pool.query(`SELECT space_key, queues FROM custom_queues`);

  const plan = drifted.map((d) => {
    const saved = deptMapGet(d.dept_assignees || {}, d.original_dept);
    const parent = parentMap.get(d.parentKey);

    // Figure out whether the ticket is currently stuck on a routing label.
    // This has to check the TARGET department's own dept_statuses entry
    // (original_dept, what current_department is about to become) rather
    // than the wrong/current one -- a subtask that hopped through several
    // departments before the lock fix existed typically has a separate
    // stale "Routed to X"/"Waiting for X" leftover parked under EACH
    // department key it ever visited (confirmed for real: CF-32993 had
    // three, one per department -- QA, Dev, AND Infra). Once
    // current_department is corrected to original_dept, that department's
    // OWN entry is what actually gets displayed going forward -- checking
    // only the old wrong department's entry (as this used to) missed that
    // entirely, restoring the department but leaving the display still
    // frozen on a different stale label than before.
    const realSt = statusRows.find((s) => s.id === d.statusId);
    const targetDeptSt = deptMapGet(d.dept_statuses || {}, d.original_dept);
    const wrongDeptSt = deptMapGet(d.dept_statuses || {}, d.current_department);
    const currentLabel = targetDeptSt?.name || wrongDeptSt?.name || realSt?.name || '';
    const isStuckOnRoutingLabel = ROUTING_LABEL.test((currentLabel || '').trim());

    let newDeptStatuses = d.dept_statuses;
    let newStatusId = d.statusId;
    let newStatusName = null;
    if (isStuckOnRoutingLabel) {
      // Find the restored department's own queue statuses.
      let queueStatuses = [];
      for (const row of queueRows) {
        const queues = row.queues || [];
        const q = queues.find((qq) => (qq.name || '').toLowerCase() === d.original_dept.toLowerCase());
        if (q?.queueStatuses?.length) { queueStatuses = q.queueStatuses; break; }
      }
      // Prefer an in_progress-category entry (the subtask had presumably
      // already been worked on, given it accumulated enough history to
      // drift departments at all) -- fall back to todo/open.
      const replacement =
        queueStatuses.find((s) => s.category === 'in_progress') ||
        queueStatuses.find((s) => s.category === 'todo') ||
        queueStatuses[0] || null;
      if (replacement) {
        newStatusName = replacement.name;
        const realMatch =
          statusRows.find((s) => s.spaceId === d.spaceId && s.name.toLowerCase() === replacement.name.toLowerCase()) ||
          statusRows.find((s) => s.spaceId === d.spaceId && s.category === replacement.category) ||
          statusRows.find((s) => s.spaceId === d.spaceId && s.category === 'todo');
        if (realMatch) newStatusId = realMatch.id;
        newDeptStatuses = {
          [d.original_dept]: {
            id: replacement.id, name: replacement.name,
            color: replacement.color || '#64748B', category: replacement.category || 'in_progress',
          },
        };
      }
    }

    return {
      id: d.id, key: d.cf_key || d.key,
      parentKey: parent?.cf_key || d.parentKey, parentSummary: parent?.summary || '',
      wrongDept: d.current_department, correctDept: d.original_dept,
      currentAssigneeId: d.assigneeId,
      restoreAssigneeId: saved?.id || null, restoreAssigneeName: saved?.displayName || saved?.id || null,
      currentLabel, isStuckOnRoutingLabel, newStatusName, newDeptStatuses, newStatusId,
    };
  });

  const restoreIds = [...new Set(plan.map((p) => p.restoreAssigneeId).filter(Boolean))];
  const { rows: existingUsers } = restoreIds.length
    ? await pool.query(`SELECT id FROM users WHERE id = ANY($1::text[])`, [restoreIds])
    : { rows: [] };
  const existingIdSet = new Set(existingUsers.map((u) => u.id));

  console.log('Plan:');
  for (const p of plan) {
    const assigneeNote = p.restoreAssigneeId
      ? (existingIdSet.has(p.restoreAssigneeId) ? ` | assignee -> ${p.restoreAssigneeName}` : ` | assignee restore skipped (saved user no longer exists)`)
      : '';
    const statusNote = p.isStuckOnRoutingLabel
      ? (p.newStatusName ? ` | status "${p.currentLabel}" -> "${p.newStatusName}"` : ` | status "${p.currentLabel}" stuck on a routing label but no replacement found -- left as-is`)
      : '';
    console.log(`  ${p.key} (under ${p.parentKey} "${p.parentSummary}"): ${p.wrongDept} -> ${p.correctDept}${assigneeNote}${statusNote}`);
  }

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to write these ${plan.length} correction(s).`);
    await pool.end();
    return;
  }

  let written = 0;
  for (const p of plan) {
    const restoreId = p.restoreAssigneeId && existingIdSet.has(p.restoreAssigneeId) ? p.restoreAssigneeId : null;
    const fixStatus = p.isStuckOnRoutingLabel && p.newStatusName;
    await pool.query(
      `UPDATE issues SET
         current_department=$1,
         "assigneeId"=COALESCE($2, "assigneeId"),
         dept_sla_started_at=NOW(),
         dept_statuses=COALESCE($3::jsonb, dept_statuses),
         "statusId"=COALESCE($4, "statusId")
       WHERE id=$5`,
      [
        p.correctDept,
        restoreId,
        fixStatus ? JSON.stringify(p.newDeptStatuses) : null,
        fixStatus ? p.newStatusId : null,
        p.id,
      ]
    );
    written++;
  }
  console.log(`\nRestored ${written} subtask(s) to their creating department.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
