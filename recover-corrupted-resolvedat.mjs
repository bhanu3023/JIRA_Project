// Recovers resolvedAt for the 11 tickets whose data shows a real, organic
// resolution event, then a LATER "Unknown -> Resolved" re-import artifact on
// 2026-09-14 that overwrote resolvedAt with that re-import's own timestamp,
// destroying the true resolution time.
//
// Confirmed for real:
//   CF-12543 -- genuinely resolved 2025-12-30 18:16:40 (real Jira-imported
//   activity: status flow Opened -> Pending with dev -> Resolved, SLA
//   start/due times, timespent logged) -- then a SECOND, unrelated wave of
//   history fired on 2026-09-14 10:53 (assignee reset, a comment, another
//   status entry literally "Unknown -> Resolved", an "SLA resolved" entry),
//   which silently reset resolvedAt to that later artifact timestamp. This
//   threw off the MBR page's "Avg. resolution (hrs)" column -- CF-12543
//   alone would report ~6185 hours (9 months) instead of its real ~22
//   minutes.
//
//   CF-10186, by contrast, has NO history at all before 2026-09-14 -- it
//   was never actually resolved before that date, so there's no earlier
//   real resolution to recover; its current resolvedAt is the best
//   available record and this script correctly leaves it alone.
//
// For each of the 11 affected tickets: look for the LATEST "status" history
// row whose newValue is a done-category status name, that occurred BEFORE
// the 2026-09-14 "Unknown -> Resolved" artifact row. If found, that's the
// real resolution moment -- reset resolvedAt to it. If not found (no
// earlier resolution exists), leave the ticket untouched.
//
// Usage:
//   node recover-corrupted-resolvedat.mjs           # dry run, full report
//   node recover-corrupted-resolvedat.mjs --apply   # writes the corrections

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const DONE_STATUS_NAMES = ['resolved', 'closed', 'done'];

async function main() {
  console.log('Finding tickets with the "Unknown -> Resolved" re-import artifact...');
  const { rows: affected } = await pool.query(`
    SELECT DISTINCT i.id, i.cf_key, i.key, i."createdAt", i."resolvedAt"
    FROM issues i
    JOIN issue_history ih ON ih."issueId" = i.id
    WHERE ih.field = 'status' AND ih."oldValue" = 'Unknown' AND ih."newValue" = 'Resolved'
  `);
  console.log(`Found ${affected.length} affected ticket(s).\n`);
  if (!affected.length) { await pool.end(); return; }

  const plan = [];
  for (const issue of affected) {
    // The artifact row itself, to know the cutoff to search before.
    const { rows: artifactRows } = await pool.query(
      `SELECT "createdAt" FROM issue_history WHERE "issueId"=$1 AND field='status' AND "oldValue"='Unknown' AND "newValue"='Resolved' ORDER BY "createdAt" DESC LIMIT 1`,
      [issue.id]
    );
    const artifactAt = artifactRows[0]?.createdAt;
    if (!artifactAt) continue;

    const { rows: priorDoneRows } = await pool.query(
      `SELECT "createdAt", "newValue" FROM issue_history
       WHERE "issueId"=$1 AND field='status' AND "createdAt" < $2 AND LOWER("newValue") = ANY($3::text[])
       ORDER BY "createdAt" DESC LIMIT 1`,
      [issue.id, artifactAt, DONE_STATUS_NAMES]
    );
    const realResolution = priorDoneRows[0];
    if (!realResolution) {
      plan.push({ key: issue.cf_key || issue.key, id: issue.id, action: 'skip', reason: 'no earlier real resolution found -- current resolvedAt is the best available record' });
      continue;
    }
    plan.push({
      key: issue.cf_key || issue.key, id: issue.id, action: 'fix',
      currentResolvedAt: issue.resolvedAt, realResolvedAt: realResolution.createdAt,
      realStatusName: realResolution.newValue,
    });
  }

  console.log('Plan:');
  for (const p of plan) {
    if (p.action === 'skip') {
      console.log(`  ${p.key}: SKIP -- ${p.reason}`);
    } else {
      console.log(`  ${p.key}: resolvedAt ${p.currentResolvedAt.toISOString()} -> ${p.realResolvedAt.toISOString()} (real "${p.realStatusName}" event)`);
    }
  }

  const toFix = plan.filter((p) => p.action === 'fix');
  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to write these ${toFix.length} correction(s) (${plan.length - toFix.length} would be left alone).`);
    await pool.end();
    return;
  }

  let written = 0;
  for (const p of toFix) {
    await pool.query(`UPDATE issues SET "resolvedAt"=$1 WHERE id=$2`, [p.realResolvedAt, p.id]);
    written++;
  }
  console.log(`\nRecovered ${written} ticket(s)' true resolvedAt.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
