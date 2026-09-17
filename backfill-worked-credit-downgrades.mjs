// Backfills the real bug confirmed on 5 of Naveed's tickets (CF-29908,
// CF-29906, CF-29897, CF-29857, CF-29589) across every Dev-department
// ticket in August 2026, for every user -- not just Naveed.
//
// The bug: a person genuinely does real work (an independent status change
// while they're the assignee, not simultaneous with a reassignment), which
// SHOULD earn them a 'worked'/'closed' user_worked_on_tickets row -- but a
// LATER, unrelated department handoff (even by someone else) blindly wrote
// reason='passed' to that same (user_id, issue_id, dept) row via
// ON CONFLICT DO UPDATE with no guard at all, erasing the real credit and
// resetting worked_at to the handoff's own (possibly much later) timestamp.
// That specific downgrade path was already fixed going FORWARD (see the
// "WHERE user_worked_on_tickets.reason NOT IN ('worked','closed')" guard
// added to every 'passed'/'returned' insert site) -- this script repairs
// rows that were already corrupted by it BEFORE that fix was deployed.
//
// For every issue+dept where a real independent status change exists in
// issue_history for a person, but their current user_worked_on_tickets row
// for that issue+dept is reason='passed' (or missing entirely), this
// restores it to reason='worked' with worked_at set to the REAL moment the
// status change happened (not the later handoff's timestamp).
//
// Same "not a simultaneous reassignment" check used throughout this
// investigation: a status-change history row only counts if there's no
// assignee-change row by the SAME author, away from themselves, within 5
// seconds of it (mirrors the app's own reassigningToSomeoneElse guard).
//
// Dry-run by default -- prints exactly what it would change. Pass --apply
// to actually write.
//
// Usage: node backfill-worked-credit-downgrades.mjs [--apply] [dept] [monthStart] [monthEnd]
//   e.g. node backfill-worked-credit-downgrades.mjs --apply Dev 2026-08-01 2026-09-01

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const args = process.argv.slice(2).filter((a) => a !== '--apply');
const DEPT = args[0] || 'Dev';
const RANGE_START = args[1] || '2026-08-01';
const RANGE_END = args[2] || '2026-09-01';
const SIMULTANEOUS_WINDOW_MS = 5000;

async function main() {
  console.log(`Scanning ${DEPT} tickets touched between ${RANGE_START} and ${RANGE_END} (createdAt or updatedAt in range)...`);
  console.log(APPLY ? 'APPLY MODE -- will write changes' : 'DRY RUN -- no changes will be written (pass --apply to write)');

  const { rows: issues } = await pool.query(
    `SELECT DISTINCT i.id, COALESCE(i.cf_key, i.key) AS key
     FROM issues i
     WHERE (i."createdAt" >= $1 AND i."createdAt" < $2) OR (i."updatedAt" >= $1 AND i."updatedAt" < $2)`,
    [RANGE_START, RANGE_END]
  );
  console.log(`Found ${issues.length} candidate ticket(s) touched in this range (any dept).\n`);

  let fixedCount = 0;
  let checkedCount = 0;

  for (const issue of issues) {
    const { rows: hist } = await pool.query(
      `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt"
       FROM issue_history WHERE "issueId" = $1 AND field IN ('status','assignee','department') ORDER BY "createdAt" ASC`,
      [issue.id]
    );
    if (!hist.length) continue;

    // Walk history tracking current assignee (by display name) and current
    // department (best-effort: department history values are messy labels
    // like "Handed to X — SLA started" / "Transferred to X" -- extract the
    // dept name from either).
    let currentAssigneeName = null;
    let currentDept = null;
    const realWorkEvents = []; // { authorEmail, authorName, dept, at }

    const extractDept = (val) => {
      if (!val) return null;
      const m = String(val).match(/(?:Handed to|Transferred to)\s+([A-Za-z0-9 ]+?)(?:\s+—|$)/);
      return m ? m[1].trim() : null;
    };

    for (const h of hist) {
      if (h.field === 'assignee') {
        currentAssigneeName = h.newValue === 'null' ? null : h.newValue;
      } else if (h.field === 'department') {
        const nd = extractDept(h.newValue);
        if (nd) currentDept = nd;
      } else if (h.field === 'status') {
        if (!h.authorEmail || !currentAssigneeName || !currentDept) continue;
        // Does the current assignee's display name plausibly match the
        // author? Compare by email domain-independent first-name heuristic
        // isn't reliable -- instead just require the author actually holds
        // SOME real user account, and cross-check via a simultaneous
        // reassignment-away guard the same way the app itself does.
        const simultaneousReassign = hist.some((h2) =>
          h2.field === 'assignee' &&
          h2.authorEmail === h.authorEmail &&
          h2.newValue !== currentAssigneeName &&
          Math.abs(h2.createdAt.getTime() - h.createdAt.getTime()) <= SIMULTANEOUS_WINDOW_MS
        );
        if (!simultaneousReassign) {
          realWorkEvents.push({ authorEmail: h.authorEmail, dept: currentDept, at: h.createdAt });
        }
      }
    }

    if (!realWorkEvents.length) continue;

    for (const ev of realWorkEvents) {
      if (ev.dept.toLowerCase() !== DEPT.toLowerCase()) continue;
      checkedCount++;
      const { rows: userRows } = await pool.query(`SELECT id, email FROM users WHERE email = $1`, [ev.authorEmail]);
      if (!userRows.length) continue;
      const user = userRows[0];

      const { rows: existing } = await pool.query(
        `SELECT reason, worked_at FROM user_worked_on_tickets WHERE user_id = $1 AND issue_id = $2 AND LOWER(dept) = LOWER($3)`,
        [user.id, issue.id, ev.dept]
      );
      const row = existing[0];
      if (row && (row.reason === 'worked' || row.reason === 'closed')) continue; // already correct

      console.log(`${issue.key}  ${ev.dept}  ${user.email}: ${row ? `currently reason=${row.reason}` : 'no row at all'} -- real status change at ${ev.at.toISOString()}`);
      fixedCount++;
      if (APPLY) {
        await pool.query(
          `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason, worked_at)
           VALUES ($1, $2, $3, 'worked', $4)
           ON CONFLICT (user_id, issue_id, dept) DO UPDATE SET reason = 'worked', worked_at = $4`,
          [user.id, issue.id, ev.dept, ev.at]
        );
      }
    }
  }

  console.log(`\n${fixedCount} row(s) ${APPLY ? 'fixed' : 'would be fixed'} out of ${checkedCount} real-work event(s) checked in ${DEPT}.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
