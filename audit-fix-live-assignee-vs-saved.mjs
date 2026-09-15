// Audits/backfills the LIVE assigneeId against dept_assignees[current_department]
// -- fallout from the redundant-handoff bug fixed in 75e4ad0 (a "Waiting for
// X"/"Routed to X" status naming the SAME department a ticket is already in
// re-ran the whole restore-or-round-robin logic, clobbering a just-correctly-
// set assignee, sometimes leaving the ticket unassigned outright even though
// a valid saved assignee for that exact department already existed).
//
// dept_assignees[dept] is the authoritative "who was last confirmed working
// this ticket while it sat in this exact department" record; a ticket's LIVE
// assigneeId should agree with it for its CURRENT department whenever a real
// saved entry exists. This finds every case where they disagree and corrects
// assigneeId to match the saved record -- never invents a value where none
// was ever saved (that's what round-robin is for, on the NEXT real handoff,
// not this backfill).
//
// Usage:
//   node audit-fix-live-assignee-vs-saved.mjs           # dry run, full report
//   node audit-fix-live-assignee-vs-saved.mjs --apply   # writes the corrections

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function deptMapGet(map, dept) {
  if (!dept) return undefined;
  const key = Object.keys(map).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  return key ? map[key] : undefined;
}

async function main() {
  console.log('Scanning issues with a current_department and dept_assignees...');
  const { rows: issues } = await pool.query(`
    SELECT id, cf_key, key, current_department, "assigneeId", dept_assignees
    FROM issues
    WHERE current_department IS NOT NULL AND current_department <> ''
      AND dept_assignees IS NOT NULL AND dept_assignees <> '{}'::jsonb
  `);
  console.log(`Found ${issues.length} candidate issues.`);

  const mismatches = [];
  for (const issue of issues) {
    const saved = deptMapGet(issue.dept_assignees || {}, issue.current_department);
    if (!saved?.id) continue; // nothing saved for this exact department -- not this bug
    if (saved.id === issue.assigneeId) continue; // already correct
    mismatches.push({
      id: issue.id, key: issue.cf_key || issue.key, dept: issue.current_department,
      savedId: saved.id, savedName: saved.displayName || saved.id,
      liveId: issue.assigneeId,
    });
  }

  console.log(`\nFound ${mismatches.length} ticket(s) whose live assignee disagrees with their own department's saved record.`);
  if (!mismatches.length) { await pool.end(); return; }

  // Verify the saved user still exists before writing it back -- same
  // safety check performDeptHandoff itself already applies on restore.
  const savedIds = [...new Set(mismatches.map((m) => m.savedId))];
  const { rows: existingUsers } = await pool.query(`SELECT id FROM users WHERE id = ANY($1::text[])`, [savedIds]);
  const existingIdSet = new Set(existingUsers.map((u) => u.id));
  const applicable = mismatches.filter((m) => existingIdSet.has(m.savedId));
  const skippedDeletedUser = mismatches.length - applicable.length;

  console.log(`  ${applicable.length} have a still-valid saved user to restore.`);
  if (skippedDeletedUser) console.log(`  ${skippedDeletedUser} skipped -- saved user no longer exists.`);

  console.log(`\nSample (first 25):`);
  for (const m of applicable.slice(0, 25)) {
    console.log(`  ${m.key} [${m.dept}]: currently ${m.liveId || '(unassigned)'} -> restoring ${m.savedName}`);
  }
  if (applicable.length > 25) console.log(`  ... and ${applicable.length - 25} more.`);

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to write these ${applicable.length} correction(s).`);
    await pool.end();
    return;
  }

  let written = 0;
  for (const m of applicable) {
    await pool.query(`UPDATE issues SET "assigneeId"=$1 WHERE id=$2`, [m.savedId, m.id]);
    written++;
    if (written % 500 === 0) console.log(`  ...${written}/${applicable.length}`);
  }
  console.log(`\nRestored ${written} ticket(s)' assignee.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
