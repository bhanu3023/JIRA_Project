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
// For each drifted subtask:
//   - current_department is restored to original_dept
//   - if a saved dept_assignees[original_dept] entry exists (and that user
//     still exists), the assignee is restored to match -- same safety
//     check performDeptHandoff itself applies on restore. Otherwise the
//     assignee is left alone (no guessing/round-robin here).
//   - dept_sla_started_at is reset to NOW() for the restored department,
//     since its SLA clock was running against the wrong department.
//
// Usage:
//   node audit-fix-subtask-department-drift.mjs           # dry run, full report
//   node audit-fix-subtask-department-drift.mjs --apply   # writes the corrections

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function deptMapGet(map, dept) {
  if (!dept) return undefined;
  const key = Object.keys(map || {}).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  return key ? map[key] : undefined;
}

async function main() {
  console.log('Scanning subtasks whose current_department has drifted from original_dept...');
  const { rows: drifted } = await pool.query(`
    SELECT id, cf_key, key, "parentKey", current_department, original_dept, "assigneeId", dept_assignees
    FROM issues
    WHERE "parentKey" IS NOT NULL
      AND original_dept IS NOT NULL AND original_dept <> ''
      AND current_department IS NOT NULL AND current_department <> ''
      AND LOWER(current_department) <> LOWER(original_dept)
  `);
  console.log(`Found ${drifted.length} drifted subtask(s).\n`);
  if (!drifted.length) { await pool.end(); return; }

  const parentKeys = [...new Set(drifted.map((d) => d.parentKey))];
  const { rows: parents } = await pool.query(
    `SELECT key, cf_key, summary FROM issues WHERE key = ANY($1::text[])`,
    [parentKeys]
  );
  const parentMap = new Map(parents.map((p) => [p.key, p]));

  const plan = drifted.map((d) => {
    const saved = deptMapGet(d.dept_assignees || {}, d.original_dept);
    const parent = parentMap.get(d.parentKey);
    return {
      id: d.id, key: d.cf_key || d.key,
      parentKey: parent?.cf_key || d.parentKey, parentSummary: parent?.summary || '',
      wrongDept: d.current_department, correctDept: d.original_dept,
      currentAssigneeId: d.assigneeId,
      restoreAssigneeId: saved?.id || null, restoreAssigneeName: saved?.displayName || saved?.id || null,
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
    console.log(`  ${p.key} (under ${p.parentKey} "${p.parentSummary}"): ${p.wrongDept} -> ${p.correctDept}${assigneeNote}`);
  }

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to write these ${plan.length} correction(s).`);
    await pool.end();
    return;
  }

  let written = 0;
  for (const p of plan) {
    const restoreId = p.restoreAssigneeId && existingIdSet.has(p.restoreAssigneeId) ? p.restoreAssigneeId : null;
    if (restoreId) {
      await pool.query(
        `UPDATE issues SET current_department=$1, "assigneeId"=$2, dept_sla_started_at=NOW() WHERE id=$3`,
        [p.correctDept, restoreId, p.id]
      );
    } else {
      await pool.query(
        `UPDATE issues SET current_department=$1, dept_sla_started_at=NOW() WHERE id=$2`,
        [p.correctDept, p.id]
      );
    }
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
