// Audits/backfills stale dept_assignees[dept] snapshots against the real,
// authoritative history log (user_worked_on_tickets). dept_assignees is
// meant to hold "whoever most recently held this ticket while it sat in
// this department" -- but it's a snapshot column, only ever written at
// specific moments (a handoff, a manual reassignment while in that dept),
// so it can silently drift out of sync with what the real event history
// says actually happened (confirmed for real in an earlier session: CF-29963
// -- Ravi's own worked-on row, snapshot said Adari Venkata Jaswanth instead).
//
// For every (issue, dept) pair with at least one real user_worked_on_tickets
// row, this finds the MOST RECENT such row (by worked_at) and treats that
// person as the ground truth for dept_assignees[dept] -- correcting the
// snapshot wherever it disagrees. This does NOT try to store multiple
// workers per department (dept_assignees is a single-value-per-department
// field by design, see its own comments in jira-pg-api.ts) -- only ever
// the latest one, same as the field's existing intended meaning.
//
// Usage:
//   node audit-fix-dept-assignees.mjs           # dry run, full report
//   node audit-fix-dept-assignees.mjs --apply   # writes the corrections

import pg from 'pg';
import { writeFile } from 'fs/promises';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const REPORT_PATH = '/app/dept_assignees_report.csv';

function deptMapGet(map, dept) {
  if (!dept) return undefined;
  const key = Object.keys(map).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  return key ? map[key] : undefined;
}
function deptMapSet(map, dept, value) {
  if (!dept) return;
  const existingKey = Object.keys(map).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  map[existingKey || dept] = value;
}

async function main() {
  console.log('Loading latest real worker per (issue, dept) from user_worked_on_tickets...');
  const { rows: latestWorkers } = await pool.query(`
    SELECT DISTINCT ON (w.issue_id, LOWER(w.dept))
      w.issue_id, w.dept, w.user_id, w.worked_at,
      u."firstName", u."lastName", u.email, u."avatarUrl"
    FROM user_worked_on_tickets w
    JOIN users u ON u.id = w.user_id
    WHERE w.dept IS NOT NULL AND w.dept <> ''
    ORDER BY w.issue_id, LOWER(w.dept), w.worked_at DESC
  `);
  console.log(`Found ${latestWorkers.length} (issue, dept) pairs with real history.`);

  const byIssue = new Map();
  for (const r of latestWorkers) {
    if (!byIssue.has(r.issue_id)) byIssue.set(r.issue_id, []);
    byIssue.get(r.issue_id).push(r);
  }

  console.log(`Scanning ${byIssue.size} issues with real worked-on history...`);
  const { rows: issues } = await pool.query(`
    SELECT id, cf_key, key, dept_assignees FROM issues WHERE id = ANY($1::text[])
  `, [[...byIssue.keys()]]);

  const mismatches = [];
  for (const issue of issues) {
    const deptAssignees = issue.dept_assignees || {};
    const workers = byIssue.get(issue.id) || [];
    let changed = false;
    const newMap = { ...deptAssignees };

    for (const w of workers) {
      const current = deptMapGet(newMap, w.dept);
      if (current?.id === w.user_id) continue; // already correct
      changed = true;
      deptMapSet(newMap, w.dept, {
        id: w.user_id,
        email: w.email,
        firstName: w.firstName,
        lastName: w.lastName,
        displayName: `${w.firstName} ${w.lastName}`.trim(),
        avatarUrl: current?.avatarUrl && current?.id === w.user_id ? current.avatarUrl : null,
      });
    }

    if (changed) {
      mismatches.push({
        id: issue.id, key: issue.cf_key || issue.key,
        before: deptAssignees, after: newMap,
      });
    }
  }

  // Flatten to one row per (ticket, dept) correction, and split into two
  // fundamentally different categories a reviewer needs to see separately:
  // "(none) -> X" is filling in a field that was simply never set (no risk
  // of overwriting anyone's real, correct data), while "Y -> X" is an actual
  // disagreement -- the snapshot claimed one specific person and the real
  // history log says it should be someone else. Lumping them into one
  // number/sample hides how much of a 24,944-ticket change is genuinely
  // "was wrong" versus "was simply blank".
  const rows = [];
  for (const m of mismatches) {
    const diffs = Object.keys(m.after).filter((k) => {
      const b = deptMapGet(m.before, k);
      const a = m.after[k];
      return b?.id !== a.id;
    });
    for (const dept of diffs) {
      const before = deptMapGet(m.before, dept);
      rows.push({
        key: m.key, dept,
        beforeName: before?.displayName || before?.id || '',
        afterName: m.after[dept].displayName,
        wasBlank: !before?.id,
      });
    }
  }
  const blankRows = rows.filter((r) => r.wasBlank);
  const wrongRows = rows.filter((r) => !r.wasBlank);

  console.log(`\nFound ${mismatches.length} ticket(s) with a stale/wrong dept_assignees snapshot (${rows.length} individual dept corrections).`);
  console.log(`  - ${blankRows.length} were simply BLANK (never set) -- pure backfill, nothing overwritten.`);
  console.log(`  - ${wrongRows.length} had a DIFFERENT person already recorded -- genuine mismatch, being corrected.`);

  console.log(`\nSample of genuine mismatches (person -> different person), first 25:`);
  for (const r of wrongRows.slice(0, 25)) {
    console.log(`  ${r.key} [${r.dept}]: ${r.beforeName} -> ${r.afterName}`);
  }
  if (wrongRows.length > 25) console.log(`  ... and ${wrongRows.length - 25} more genuine mismatches.`);

  const csvLines = ['key,dept,before,after,was_blank'];
  for (const r of rows) {
    const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
    csvLines.push([esc(r.key), esc(r.dept), esc(r.beforeName), esc(r.afterName), r.wasBlank].join(','));
  }
  await writeFile(REPORT_PATH, csvLines.join('\n'), 'utf8');
  console.log(`\nFull list of all ${rows.length} corrections written to ${REPORT_PATH} -- copy it out with:`);
  console.log(`  docker cp jira_app:${REPORT_PATH} ./dept_assignees_report.csv`);

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to write these ${mismatches.length} correction(s).`);
    await pool.end();
    return;
  }

  let written = 0;
  for (const m of mismatches) {
    // NOT touching "updatedAt" here: it's a real, user-visible field that
    // every "Updated" date filter across the app depends on -- backfilling
    // a derived snapshot field is not a genuine ticket update and must
    // never bump it. (An earlier version of this script did set it to
    // NOW(), which corrupted the real last-touched timestamp on every
    // corrected ticket -- see recover-corrupted-updatedat.mjs for the
    // cleanup that was needed as a result.)
    await pool.query(`UPDATE issues SET dept_assignees=$1::jsonb WHERE id=$2`, [JSON.stringify(m.after), m.id]);
    written++;
    if (written % 500 === 0) console.log(`  ...${written}/${mismatches.length}`);
  }
  console.log(`\nCorrected ${written} ticket(s).`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
