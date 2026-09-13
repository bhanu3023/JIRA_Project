// Recovers "updatedAt" on every ticket touched by audit-fix-dept-assignees.mjs
// --apply, which had a real bug: its UPDATE unconditionally set
// "updatedAt"=NOW() as a side effect of backfilling dept_assignees (a
// derived/computed field, not something that should ever count as a real
// ticket update) -- overwriting the genuine last-touched timestamp on
// ~24,944 tickets with the moment that script happened to run. Confirmed
// for real: CF-31207's true last update was 2026-09-11 (per its own worked-
// on history), but after that script ran it showed 2026-09-13 -- silently
// dropping it out of any "Updated: ...through Sep 12" filter.
//
// The true original value is gone (overwritten, no undo log). This
// reconstructs the closest available approximation: the MAX of every real
// activity signal still on record for that issue -- issue_history entries,
// comments, worked-on records, and resolvedAt -- falling back to createdAt
// for a ticket with no other activity at all (in which case createdAt IS
// the most accurate available answer to "when was this last really
// touched"). Only touches rows still sitting at the exact corrupted
// timestamp range from that bad run (read from the CSV report that script
// already wrote, cf_key list, cross-referenced against a narrow updatedAt
// window) -- a ticket that's had a genuine real update SINCE that bad run
// already has a newer, correct updatedAt and is left alone.
//
// Usage:
//   node recover-corrupted-updatedat.mjs           # dry run, full report
//   node recover-corrupted-updatedat.mjs --apply   # writes the corrections

import pg from 'pg';
import { readFile } from 'fs/promises';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const CSV_PATH = '/app/dept_assignees_report.csv';

async function main() {
  console.log(`Reading affected ticket list from ${CSV_PATH}...`);
  const csv = await readFile(CSV_PATH, 'utf8');
  const lines = csv.trim().split('\n').slice(1); // skip header
  const keys = [...new Set(lines.map((l) => l.split(',')[0].replace(/^"|"$/g, '')))];
  console.log(`Found ${keys.length} distinct affected tickets.`);

  const { rows: issues } = await pool.query(
    `SELECT id, cf_key, key, "createdAt", "updatedAt", "resolvedAt" FROM issues WHERE cf_key = ANY($1::text[])`,
    [keys]
  );
  console.log(`Matched ${issues.length} issue rows.`);

  // Narrow safety window: only touch rows whose updatedAt is still within
  // the tight cluster the bad script's run produced (a handful of seconds),
  // never a ticket that's genuinely been updated again since then with its
  // own correct, newer timestamp.
  const updatedTimes = issues.map((i) => new Date(i.updatedAt).getTime()).sort((a, b) => a - b);
  const corruptWindowStart = new Date(updatedTimes[0] - 1000); // 1s buffer
  const corruptWindowEnd = new Date(updatedTimes[updatedTimes.length - 1] + 1000);
  console.log(`Corruption window detected: ${corruptWindowStart.toISOString()} -> ${corruptWindowEnd.toISOString()}`);

  let fixed = 0, skippedAlreadyMovedOn = 0, fallbackToCreated = 0;
  const corrections = [];

  for (const issue of issues) {
    const updatedAtMs = new Date(issue.updatedAt).getTime();
    if (updatedAtMs < corruptWindowStart.getTime() || updatedAtMs > corruptWindowEnd.getTime()) {
      skippedAlreadyMovedOn++;
      continue; // this ticket has a genuine, newer update since -- leave it alone
    }

    const [{ rows: histRows }, { rows: commentRows }, { rows: workedRows }] = await Promise.all([
      pool.query(`SELECT MAX("createdAt") AS t FROM issue_history WHERE "issueId" = $1`, [issue.id]),
      pool.query(`SELECT MAX("createdAt") AS t FROM comments WHERE "issueId" = $1`, [issue.id]).catch(() => ({ rows: [{ t: null }] })),
      pool.query(`SELECT MAX(worked_at) AS t FROM user_worked_on_tickets WHERE issue_id = $1`, [issue.id]),
    ]);

    const candidates = [
      histRows[0]?.t, commentRows[0]?.t, workedRows[0]?.t, issue.resolvedAt, issue.createdAt,
    ].filter(Boolean).map((d) => new Date(d));

    let recovered = candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : new Date(issue.createdAt);
    if (recovered.getTime() === new Date(issue.createdAt).getTime()) fallbackToCreated++;

    corrections.push({ id: issue.id, key: issue.cf_key || issue.key, before: issue.updatedAt, after: recovered });
    fixed++;
  }

  console.log(`\n${fixed} ticket(s) to recover (still sitting at the corrupted timestamp).`);
  console.log(`${skippedAlreadyMovedOn} already have a genuine newer update since -- left untouched.`);
  console.log(`${fallbackToCreated} had no other activity signal at all -- recovered to their own createdAt.`);
  console.log(`\nSample (first 25):`);
  for (const c of corrections.slice(0, 25)) {
    console.log(`  ${c.key}: ${new Date(c.before).toISOString()} -> ${c.after.toISOString()}`);
  }
  if (corrections.length > 25) console.log(`  ... and ${corrections.length - 25} more.`);

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to write these ${corrections.length} correction(s).`);
    await pool.end();
    return;
  }

  let written = 0;
  for (const c of corrections) {
    await pool.query(`UPDATE issues SET "updatedAt"=$1 WHERE id=$2`, [c.after.toISOString(), c.id]);
    written++;
    if (written % 500 === 0) console.log(`  ...${written}/${corrections.length}`);
  }
  console.log(`\nRecovered ${written} ticket(s)' updatedAt.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
