// Broader version of the CF-33269 fix: finds every subtask (parentKey IS
// NOT NULL) whose original_dept doesn't match its creator's own single
// queue membership -- i.e. every subtask potentially affected by the same
// bug just fixed (a new subtask's department used to come from the
// parent's transient current_department instead of who actually created
// it). Only flags a mismatch when the creator belongs to EXACTLY ONE queue
// in the ticket's space (an unambiguous signal) -- ambiguous cases are
// left alone rather than guessed at.
//
// Usage:
//   node check-all-subtasks-wrong-origin-dept.mjs            (dry run, lists mismatches)
//   node check-all-subtasks-wrong-origin-dept.mjs --apply     (fixes original_dept for
//                                                               tickets still sitting in
//                                                               their creator's queue --
//                                                               see the per-row note)

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows: subtasks } = await pool.query(
    `SELECT i.id, i.cf_key, i.key, i."spaceId", i.current_department, i.original_dept, i."reporterId", sp.key AS space_key
     FROM issues i JOIN spaces sp ON sp.id = i."spaceId"
     WHERE i."parentKey" IS NOT NULL`
  );

  // Preload every queue's member list per space, once.
  const { rows: cqRows } = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  const queuesBySpace = {};
  for (const row of cqRows) queuesBySpace[row.space_key] = row.queues || [];

  let checked = 0, mismatches = 0, applied = 0;
  for (const t of subtasks) {
    if (!t.reporterId || !t.original_dept) continue;
    const queues = queuesBySpace[t.space_key] || [];
    const memberQueues = queues.filter((q) => Array.isArray(q.memberIds) && q.memberIds.includes(t.reporterId) && q.name).map((q) => q.name);
    if (memberQueues.length !== 1) continue; // ambiguous -- skip
    checked++;
    const creatorDept = memberQueues[0];
    if (creatorDept.toLowerCase() === String(t.original_dept).toLowerCase()) continue; // already correct

    mismatches++;
    console.log(`${t.cf_key || t.key}: original_dept="${t.original_dept}" but creator's queue is "${creatorDept}" (current_department="${t.current_department}")`);

    if (APPLY) {
      // Only safe to auto-apply when the ticket is STILL sitting in the
      // creator's own queue right now (current_department already matches
      // creatorDept) -- same conservative guard as the CF-33269 fix, so
      // this never overwrites original_dept for a ticket that's genuinely
      // moved on since and where the "real" origin is now ambiguous.
      if (String(t.current_department || '').toLowerCase() === creatorDept.toLowerCase()) {
        await pool.query(`UPDATE issues SET original_dept = $1 WHERE id = $2`, [creatorDept, t.id]);
        applied++;
        console.log(`  -> applied (current_department already matches creator's queue)`);
      } else {
        console.log(`  -> SKIPPED (current_department doesn't match creator's queue right now -- review manually)`);
      }
    }
  }

  console.log(`\nChecked ${checked} subtasks with unambiguous single-queue creators; ${mismatches} mismatches found${APPLY ? `, ${applied} applied` : ' (dry run -- re-run with --apply)'}.`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
