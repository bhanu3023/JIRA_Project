// Fixes stale dept_assignees[current_department] snapshots -- confirmed for
// real on CF-12035: it was reassigned Shiva Amuda -> Vishal Kumar (recorded
// correctly in dept_assignees.Dev at that moment), then reassigned AGAIN to
// a different person later that same day while still sitting in Dev (no
// department transfer involved). dept_assignees only gets refreshed at the
// moment of a department handoff (or via the newer "keep dept_assignees in
// sync on assignee change" code in the plain PATCH handler) -- a ticket
// whose most recent assignee change predates that sync code, or that somehow
// bypassed it, is left with a snapshot frozen at an old assignee while the
// live assigneeId has since moved on.
//
// IMPORTANT -- this script only auto-fixes the PROVEN subset. Checked
// against real data (CF-23967): plenty of "snapshot says X, live says
// unassigned" tickets have ZERO issue_history row showing X being
// unassigned -- meaning there's no direct evidence the live "(unassigned)"
// state is even correct; it could itself be a different, untracked bug (a
// silent clear that never logged history) rather than the snapshot being
// stale. Blindly syncing those would risk erasing a genuinely correct saved
// name. "Proof" here means the most recent 'assignee' issue_history row for
// this ticket matches the live value (its newValue is the live assignee's
// name, or blank/empty if live is unassigned) -- the same kind of direct
// evidence CF-12035 had (a real, later, recorded reassignment). Anything
// without that proof is reported separately and left untouched.
//
// Usage:
//   node audit-fix-dept-assignees-drift.mjs           # dry run, full report
//   node audit-fix-dept-assignees-drift.mjs --apply   # writes the PROVEN corrections only

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function deptMapGet(map, dept) {
  if (!dept) return undefined;
  const key = Object.keys(map || {}).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  return key ? map[key] : undefined;
}

function norm(s) {
  return (s || '').trim().toLowerCase();
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

  const disagreeing = [];
  for (const issue of issues) {
    const saved = deptMapGet(issue.dept_assignees || {}, issue.current_department);
    const liveId = issue.assigneeId || null;
    const savedId = saved?.id || null;
    if (savedId === liveId) continue;
    disagreeing.push({
      id: issue.id, key: issue.cf_key || issue.key, dept: issue.current_department,
      savedName: saved?.displayName || savedId || '(none)',
      liveName: liveId ? `${issue.live_first || ''} ${issue.live_last || ''}`.trim() || liveId : '(unassigned)',
      liveId, liveEmail: issue.live_email, liveFirst: issue.live_first, liveLast: issue.live_last, liveAvatar: issue.live_avatar,
      deptAssignees: issue.dept_assignees || {},
    });
  }
  console.log(`Found ${disagreeing.length} ticket(s) whose department snapshot disagrees with the live assignee. Checking each for proof...`);

  const proven = [];
  const unproven = [];
  for (const p of disagreeing) {
    const { rows: lastAssigneeRows } = await pool.query(
      `SELECT "newValue" FROM issue_history WHERE "issueId"=$1 AND field='assignee' ORDER BY "createdAt" DESC LIMIT 1`,
      [p.id]
    );
    const lastRecorded = lastAssigneeRows[0]?.newValue ?? null;
    const liveNameNorm = p.liveId ? norm(p.liveName) : '';
    const hasProof = p.liveId
      ? norm(lastRecorded) === liveNameNorm && liveNameNorm !== ''
      : (lastRecorded === '' || lastRecorded === null);
    (hasProof ? proven : unproven).push(p);
  }

  console.log(`\n${proven.length} PROVEN (a real, later issue_history row confirms the live value) -- safe to auto-fix.`);
  console.log(`${unproven.length} UNPROVEN (no history row confirms the live value -- left untouched, needs manual review).\n`);

  console.log('Proven sample (first 20):');
  for (const p of proven.slice(0, 20)) {
    console.log(`  ${p.key} [${p.dept}]: snapshot says "${p.savedName}" -> syncing to live "${p.liveName}"`);
  }
  if (proven.length > 20) console.log(`  ... and ${proven.length - 20} more.`);

  console.log('\nUnproven sample (first 20) -- NOT touched by --apply:');
  for (const p of unproven.slice(0, 20)) {
    console.log(`  ${p.key} [${p.dept}]: snapshot says "${p.savedName}", live says "${p.liveName}" -- no confirming history row`);
  }
  if (unproven.length > 20) console.log(`  ... and ${unproven.length - 20} more.`);

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to write the ${proven.length} PROVEN correction(s) (unproven ones are never auto-applied).`);
    await pool.end();
    return;
  }

  let written = 0;
  for (const p of proven) {
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
    if (written % 500 === 0) console.log(`  ...${written}/${proven.length}`);
  }
  console.log(`\nSynced ${written} PROVEN ticket(s)' department assignee snapshot to match their live assignee.`);
  console.log(`${unproven.length} unproven ticket(s) were left untouched -- see the sample above for manual review.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
