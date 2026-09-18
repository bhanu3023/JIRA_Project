// v1 required an unambiguous single status-row match to auto-derive the
// target time and may not have applied. User gave an exact target instead:
// Aug 6, 2026, 6:43 AM (IST, matching how the app displays all other
// timestamps) for the "changed Attachment" / "Added Root Cause Analysis..."
// history entry on CF-31240, currently showing 18/Sep/26 11:49 PM.
// Sets it directly, no matching-required guesswork.
//
// Usage: node fix-cf31240-attachment-date-v2.mjs [--apply]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

async function main() {
  const { rows: issueRows } = await pool.query(`SELECT id FROM issues WHERE cf_key = 'CF-31240' OR key = 'CF-31240'`);
  if (!issueRows.length) { console.log('CF-31240 not found'); await pool.end(); return; }
  const issueId = issueRows[0].id;

  const { rows: attachRows } = await pool.query(
    `SELECT id, field, "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
     WHERE "issueId" = $1 AND field ILIKE 'attachment%' AND "newValue" ILIKE '%Root Cause Analysis%'
     ORDER BY "createdAt" DESC`,
    [issueId]
  );
  console.log('Matching attachment rows:');
  for (const r of attachRows) console.log(`  id=${r.id} field="${r.field}" [${r.createdAt.toISOString()}] "${r.oldValue}" -> "${r.newValue}" (by ${r.authorName})`);

  if (attachRows.length !== 1) {
    console.log(`\n${attachRows.length === 0 ? 'No match found' : 'Multiple matches found'} -- not applying automatically. Review above.`);
    await pool.end();
    return;
  }

  // Aug 6, 2026, 6:43 AM IST -> UTC
  const targetUtc = new Date(Date.UTC(2026, 7, 6, 6, 43, 0) - IST_OFFSET_MS);
  console.log(`\n${APPLY ? 'Setting' : 'Would set'} createdAt to: ${targetUtc.toISOString()} (= 06/Aug/26 6:43 AM IST)`);
  if (APPLY) {
    await pool.query(`UPDATE issue_history SET "createdAt" = $1 WHERE id = $2`, [targetUtc, attachRows[0].id]);
    console.log('Applied.');
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
