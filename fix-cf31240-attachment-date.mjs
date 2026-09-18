// Per explicit request: CF-31240's "changed Attachment" history entry
// ("Added Root Cause Analysis d...", currently 18/Sep/26 11:49 PM) should
// have its date/time changed to match the "changed Status" entry right
// below it (06/Aug/26 6:48 AM, by srinu gudimitla). Finds that status row's
// exact createdAt as the reference, then sets the attachment row's
// createdAt to that same instant minus 1 second (so it still sorts
// immediately after the status change in the newest-first history list,
// matching the screenshot's order, without being bit-for-bit identical).
//
// Usage: node fix-cf31240-attachment-date.mjs [--apply]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows: issueRows } = await pool.query(`SELECT id FROM issues WHERE cf_key = 'CF-31240' OR key = 'CF-31240'`);
  if (!issueRows.length) { console.log('CF-31240 not found'); await pool.end(); return; }
  const issueId = issueRows[0].id;

  const { rows: statusRows } = await pool.query(
    `SELECT id, "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
     WHERE "issueId" = $1 AND field = 'status' AND "authorName" ILIKE 'srinu%'
     ORDER BY "createdAt" ASC LIMIT 5`,
    [issueId]
  );
  console.log('Candidate status rows (srinu gudimitla):');
  for (const r of statusRows) console.log(`  [${r.createdAt.toISOString()}] "${r.oldValue}" -> "${r.newValue}"`);

  const { rows: attachRows } = await pool.query(
    `SELECT id, field, "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
     WHERE "issueId" = $1 AND field ILIKE 'attachment%' AND "newValue" ILIKE '%Root Cause Analysis%'`,
    [issueId]
  );
  console.log('\nCandidate attachment rows:');
  for (const r of attachRows) console.log(`  id=${r.id} [${r.createdAt.toISOString()}] "${r.oldValue}" -> "${r.newValue}" (by ${r.authorName})`);

  if (statusRows.length !== 1 || attachRows.length !== 1) {
    console.log('\nAmbiguous or missing match -- not applying automatically. Review the candidates above.');
    await pool.end();
    return;
  }

  const target = new Date(statusRows[0].createdAt.getTime() - 1000);
  console.log(`\n${APPLY ? 'Setting' : 'Would set'} attachment row createdAt to: ${target.toISOString()}`);
  if (APPLY) {
    await pool.query(`UPDATE issue_history SET "createdAt" = $1 WHERE id = $2`, [target, attachRows[0].id]);
    console.log('Applied.');
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
