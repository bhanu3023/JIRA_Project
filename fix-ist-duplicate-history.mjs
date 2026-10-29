// Deletes the later (IST-offset, +5h30m) duplicate of each status-history
// pair identified by check-ist-duplicate-history-scope.mjs. For each row
// pair sharing the same issueId/field/oldValue/newValue/authorName where one
// row's createdAt is exactly ~5h30m after the other's, the EARLIER row is
// kept (it's the genuine event) and the LATER row is deleted (the
// IST-shifted duplicate).
//
// Safety:
//  - Defaults to DRY RUN (no deletes). Pass --apply to actually delete.
//  - Only ever matches on field='status' (the field this bug was scoped to
//    -- see check-ist-duplicate-history-scope.mjs's findings).
//  - Explicitly checks for "chains" (a row that would be deleted as someone
//    else's duplicate AND kept as another pair's original, e.g. three
//    copies 5h30m apart) and refuses to run if any exist, since this
//    script's 1-keep/1-delete-per-pair logic assumes clean pairs only.
//  - Runs everything in a single transaction; rolls back on any error.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const FIVE_THIRTY_MS = 5.5 * 60 * 60 * 1000;
const APPLY = process.argv.includes('--apply');

async function main() {
  const client = await pool.connect();
  try {
    const { rows: pairs } = await client.query(`
      SELECT h1.id AS keep_id, h2.id AS delete_id,
             h1."issueId", COALESCE(i.cf_key, i.key) AS key,
             h1."createdAt" AS t1, h2."createdAt" AS t2
      FROM issue_history h1
      JOIN issue_history h2
        ON h2."issueId" = h1."issueId"
       AND h2.field = h1.field
       AND COALESCE(h2."oldValue", '') = COALESCE(h1."oldValue", '')
       AND COALESCE(h2."newValue", '') = COALESCE(h1."newValue", '')
       AND COALESCE(h2."authorName", '') = COALESCE(h1."authorName", '')
      JOIN issues i ON i.id = h1."issueId"
      WHERE h1.field = 'status'
        AND h2."createdAt" > h1."createdAt"
        AND ABS(EXTRACT(EPOCH FROM (h2."createdAt" - h1."createdAt")) * 1000 - $1) < 2000
    `, [FIVE_THIRTY_MS]);

    console.log(`Found ${pairs.length} duplicate pairs (keep earlier / delete later).`);

    const keepIds = new Set(pairs.map((p) => p.keep_id));
    const deleteIds = new Set(pairs.map((p) => p.delete_id));
    const chained = [...deleteIds].filter((id) => keepIds.has(id));
    if (chained.length) {
      console.error(`\nABORTING: ${chained.length} row(s) appear as both a "keep" and a "delete" target (a chain of 3+ near-identical rows) -- this script's logic only handles clean pairs. Needs manual review. Sample ids:`, chained.slice(0, 10));
      process.exit(1);
    }

    // Dedupe delete_id list -- a row could theoretically match more than one
    // h1 (shouldn't happen given the exact-timestamp-gap match, but be safe).
    const uniqueDeleteIds = [...deleteIds];
    console.log(`Distinct rows to delete: ${uniqueDeleteIds.length}`);
    console.log('\nSample (first 10):');
    for (const p of pairs.slice(0, 10)) {
      console.log(` - ${p.key}: keep ${p.keep_id} (${p.t1.toISOString()})  delete ${p.delete_id} (${p.t2.toISOString()})`);
    }

    if (!APPLY) {
      console.log('\nDRY RUN ONLY -- no rows deleted. Re-run with --apply to actually delete.');
      return;
    }

    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `DELETE FROM issue_history WHERE id = ANY($1::text[])`,
      [uniqueDeleteIds]
    );
    await client.query('COMMIT');
    console.log(`\nDeleted ${rowCount} duplicate rows.`);

    // Post-check: re-run the same detection query, should now find 0.
    const { rows: remaining } = await client.query(`
      SELECT COUNT(*) FROM issue_history h1
      JOIN issue_history h2
        ON h2."issueId" = h1."issueId" AND h2.field = h1.field
       AND COALESCE(h2."oldValue", '') = COALESCE(h1."oldValue", '')
       AND COALESCE(h2."newValue", '') = COALESCE(h1."newValue", '')
       AND COALESCE(h2."authorName", '') = COALESCE(h1."authorName", '')
      WHERE h1.field = 'status'
        AND h2."createdAt" > h1."createdAt"
        AND ABS(EXTRACT(EPOCH FROM (h2."createdAt" - h1."createdAt")) * 1000 - $1) < 2000
    `, [FIVE_THIRTY_MS]);
    console.log(`Remaining duplicate pairs after cleanup: ${remaining[0].count}`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
