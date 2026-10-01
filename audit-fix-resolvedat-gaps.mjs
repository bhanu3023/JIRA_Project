// Fixes the two resolvedAt/status inconsistencies found by
// audit-check-people-tickets.mjs, system-wide (the underlying gap isn't
// specific to any one person -- it affects MBR's "Avg Resolution Hours").
//
// Case A: status is done-category (Resolved/Closed) but resolvedAt is NULL.
//   Most of these are tickets imported from the original Jira already in a
//   resolved state (confirmed elsewhere in this codebase -- see the
//   "resolvedAt is never populated..." comments in jira-pg-api.ts) -- they
//   never passed through this app's own PATCH handler, which is the only
//   code path that stamps resolvedAt. Fix: if a real issue_history row shows
//   the status becoming done at some point, use that row's timestamp as the
//   true resolution time (same technique already used for the Sept-14 MBR
//   corruption recovery). If no such row exists, leave it alone -- there is
//   no evidence to backfill from, and guessing (e.g. using updatedAt) would
//   just create a different kind of wrong data.
//
//   IMPORTANT: this DB also has several bulk status-cleanup artifacts (e.g.
//   ~4,500 tickets flipped "Closed -> Resolved" in batches of exactly 500,
//   all at the identical millisecond, across events on 2026-02-06, 2026-01-21
//   and 2025-11-26 -- confirmed via investigate-resolved-timestamp-clusters.mjs,
//   not organic individual resolutions). 330 of those tickets have that fake
//   timestamp as their ONLY "done" row, so "earliest done row" alone would
//   pick up the artifact for them. Any timestamp shared by more than 5
//   different tickets' status-done rows at the same instant is excluded from
//   being used as evidence here, system-wide, not just for these known dates
//   -- the same fingerprint would catch any future bulk artifact too.
//
// Case B: status is NOT done-category but resolvedAt IS set (a resolved
//   ticket got reopened/routed back, and resolvedAt was never cleared).
//   Fix: clear it to NULL -- this exactly mirrors the live PATCH handler's
//   own rule (jira-pg-api.ts: "!willBeResolved && wasResolved => resolvedAtChange = null"),
//   so it's not a guess, it's applying the app's own existing logic
//   retroactively.
//
// Usage:
//   node audit-fix-resolvedat-gaps.mjs           # dry run, full report
//   node audit-fix-resolvedat-gaps.mjs --apply   # writes the corrections

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const DONE_STATUS_NAMES = ['resolved', 'closed', 'done'];

async function main() {
  console.log('Finding bulk-artifact timestamps to exclude as evidence...');
  const { rows: badTimestamps } = await pool.query(`
    SELECT "createdAt" FROM issue_history
    WHERE field = 'status' AND LOWER("newValue") = ANY($1::text[])
    GROUP BY "createdAt"
    HAVING COUNT(*) > 5
  `, [DONE_STATUS_NAMES]);
  const excluded = new Set(badTimestamps.map(r => r.createdAt.toISOString()));
  console.log(`Excluding ${excluded.size} timestamp(s) shared by >5 tickets' "done" rows at the same instant (bulk-artifact fingerprint).`);

  const { rows: issues } = await pool.query(`
    SELECT i.id, i.cf_key, i.key, i."resolvedAt", s.name AS status_name, s.category AS status_category
    FROM issues i
    LEFT JOIN statuses s ON s.id = i."statusId"
  `);
  console.log(`Scanning ${issues.length} issue(s)...`);

  const caseA_fix = [];    // done, no resolvedAt, history proves a resolution moment
  const caseA_skip = [];   // done, no resolvedAt, no evidence -- left alone
  const caseB_fix = [];    // not done, resolvedAt set -- clear it

  for (const row of issues) {
    const key = row.cf_key || row.key;
    const isDone = row.status_category === 'done';

    if (isDone && !row.resolvedAt) {
      const { rows: doneRows } = await pool.query(
        `SELECT "createdAt", "newValue" FROM issue_history
         WHERE "issueId"=$1 AND field='status' AND LOWER("newValue") = ANY($2::text[])
         ORDER BY "createdAt" ASC`,
        [row.id, DONE_STATUS_NAMES]
      );
      const realRow = doneRows.find(r => !excluded.has(r.createdAt.toISOString()));
      if (realRow) {
        caseA_fix.push({ id: row.id, key, resolvedAt: realRow.createdAt, statusName: realRow.newValue });
      } else if (doneRows.length) {
        caseA_skip.push({ key, reason: `only bulk-artifact timestamp(s) found (${doneRows.length} row(s), all excluded) -- no genuine evidence to backfill from` });
      } else {
        caseA_skip.push({ key, reason: 'no issue_history row shows this ticket ever becoming done -- likely imported already-resolved, no evidence to backfill from' });
      }
    }

    if (!isDone && row.resolvedAt) {
      caseB_fix.push({ id: row.id, key, oldResolvedAt: row.resolvedAt, statusName: row.status_name });
    }
  }

  console.log(`\n=== Case A: backfill resolvedAt from real history (${caseA_fix.length} fixable, ${caseA_skip.length} no evidence) ===`);
  for (const p of caseA_fix.slice(0, 20)) console.log(`  ${p.key}: resolvedAt -> ${p.resolvedAt.toISOString()} (real "${p.statusName}" event)`);
  if (caseA_fix.length > 20) console.log(`  ...and ${caseA_fix.length - 20} more`);
  console.log(`  (${caseA_skip.length} left untouched -- no history evidence)`);

  console.log(`\n=== Case B: clear stale resolvedAt on reopened tickets (${caseB_fix.length}) ===`);
  for (const p of caseB_fix.slice(0, 20)) console.log(`  ${p.key}: status="${p.statusName}" (not done) -- clearing resolvedAt (was ${p.oldResolvedAt.toISOString()})`);
  if (caseB_fix.length > 20) console.log(`  ...and ${caseB_fix.length - 20} more`);

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to write ${caseA_fix.length + caseB_fix.length} correction(s).`);
    await pool.end();
    return;
  }

  let written = 0;
  for (const p of caseA_fix) {
    await pool.query(`UPDATE issues SET "resolvedAt"=$1 WHERE id=$2`, [p.resolvedAt, p.id]);
    written++;
  }
  for (const p of caseB_fix) {
    await pool.query(`UPDATE issues SET "resolvedAt"=NULL WHERE id=$1`, [p.id]);
    written++;
  }
  console.log(`\nApplied ${written} correction(s) (${caseA_fix.length} backfilled, ${caseB_fix.length} cleared). ${caseA_skip.length} left untouched for lack of evidence.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
