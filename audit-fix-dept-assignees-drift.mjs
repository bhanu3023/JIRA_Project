// Fixes stale dept_assignees[current_department] snapshots -- confirmed for
// real on CF-12035: it was reassigned Shiva Amuda -> Vishal Kumar (recorded
// correctly in dept_assignees.Dev at that moment), then reassigned AGAIN to
// a different person later that same day while still sitting in Dev (no
// department transfer involved). dept_assignees only gets refreshed at the
// moment of a department handoff (or via the newer "keep dept_assignees in
// sync on assignee change" code in the plain PATCH handler) -- a ticket
// whose most recent assignee change predates that sync code, or that somehow
// bypassed it, is left with a snapshot frozen at an old assignee while the
// live assigneeId has since moved on. Any view that ever reads that
// department's snapshot (a "Worked" date filter, or a future return visit to
// this same department after leaving and coming back) would show the wrong,
// stale person.
//
// The live assigneeId is always the authoritative "who's actually on it
// right now" for the department a ticket CURRENTLY sits in -- this brings
// dept_assignees[current_department] back in sync with it wherever they've
// drifted apart, for tickets currently in a department (not tickets that
// have since moved on, which is a separate, already-correct "historical
// snapshot" case this script doesn't touch).
//
// Usage:
//   node audit-fix-dept-assignees-drift.mjs           # dry run, full report
//   node audit-fix-dept-assignees-drift.mjs --apply   # writes the corrections

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function deptMapGet(map, dept) {
  if (!dept) return undefined;
  const key = Object.keys(map || {}).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  return key ? map[key] : undefined;
}

async function main() {
  console.log('Scanning issues whose current department\'s saved assignee snapshot disagrees with the live assignee...');
  const { rows: issues } = await pool.query(`
    SELECT i.id, i.cf_key, i.key, i.current_department, i."assigneeId", i.dept_assignees,
           u.id AS live_id, u.email AS live_email, u."firstName" AS live_first, u."lastName" AS live_last, u."avatarUrl" AS live_avatar
    FROM issues i
    LEFT JOIN users u ON u.id = i."assigneeId"
    WHERE i.current_department IS NOT NULL AND i.current_department <> ''
      AND i.dept_assignees IS NOT NULL AND i.dept_assignees <> '{}'::jsonb
  `);
  console.log(`Scanning ${issues.length} candidate issue(s)...`);

  const plan = [];
  for (const issue of issues) {
    const saved = deptMapGet(issue.dept_assignees || {}, issue.current_department);
    const liveId = issue.assigneeId || null;
    const savedId = saved?.id || null;
    if (savedId === liveId) continue; // already in sync (including both-null: unassigned, no snapshot needed)
    plan.push({
      id: issue.id, key: issue.cf_key || issue.key, dept: issue.current_department,
      savedName: saved?.displayName || savedId || '(none)',
      liveName: liveId ? `${issue.live_first || ''} ${issue.live_last || ''}`.trim() || liveId : '(unassigned)',
      liveId, liveEmail: issue.live_email, liveFirst: issue.live_first, liveLast: issue.live_last, liveAvatar: issue.live_avatar,
      deptAssignees: issue.dept_assignees || {},
    });
  }

  console.log(`\nFound ${plan.length} ticket(s) whose department snapshot disagrees with the live assignee.\n`);
  if (!plan.length) { await pool.end(); return; }

  console.log('Sample (first 30):');
  for (const p of plan.slice(0, 30)) {
    console.log(`  ${p.key} [${p.dept}]: snapshot says "${p.savedName}" -> syncing to live "${p.liveName}"`);
  }
  if (plan.length > 30) console.log(`  ... and ${plan.length - 30} more.`);

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to write these ${plan.length} correction(s).`);
    await pool.end();
    return;
  }

  let written = 0;
  for (const p of plan) {
    const deptAssignees = { ...p.deptAssignees };
    const existingKey = Object.keys(deptAssignees).find((k) => k.toLowerCase() === p.dept.trim().toLowerCase());
    const mapKey = existingKey || p.dept;
    if (p.liveId) {
      deptAssignees[mapKey] = {
        id: p.liveId, email: p.liveEmail, firstName: p.liveFirst, lastName: p.liveLast,
        displayName: `${p.liveFirst || ''} ${p.liveLast || ''}`.trim(),
        avatarUrl: p.liveAvatar,
      };
    } else {
      delete deptAssignees[mapKey];
    }
    await pool.query(`UPDATE issues SET dept_assignees=$1::jsonb WHERE id=$2`, [JSON.stringify(deptAssignees), p.id]);
    written++;
    if (written % 500 === 0) console.log(`  ...${written}/${plan.length}`);
  }
  console.log(`\nSynced ${written} ticket(s)' department assignee snapshot to match their live assignee.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
