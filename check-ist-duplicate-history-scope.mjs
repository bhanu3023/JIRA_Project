// Read-only: find how widespread the "every status-history row duplicated
// exactly 5h30m (IST offset) later" bug is -- CF-28248 showed every single
// field='status' row duplicated with an identical oldValue/newValue/author
// but createdAt exactly +19800000ms (5h30m) later. Quantify before deciding
// on a fix (dedupe at display time vs. a one-off data cleanup).
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const FIVE_THIRTY_MS = 5.5 * 60 * 60 * 1000;

async function main() {
  const { rows: pairs } = await pool.query(`
    SELECT h1."issueId", COALESCE(i.cf_key, i.key) AS key, h1.field,
           h1."oldValue", h1."newValue", h1."authorName",
           h1."createdAt" AS t1, h2."createdAt" AS t2
    FROM issue_history h1
    JOIN issue_history h2
      ON h2."issueId" = h1."issueId"
     AND h2.field = h1.field
     AND COALESCE(h2."oldValue", '') = COALESCE(h1."oldValue", '')
     AND COALESCE(h2."newValue", '') = COALESCE(h1."newValue", '')
     AND COALESCE(h2."authorName", '') = COALESCE(h1."authorName", '')
     AND h2.id > h1.id
    JOIN issues i ON i.id = h1."issueId"
    WHERE h1.field = 'status'
      AND ABS(EXTRACT(EPOCH FROM (h2."createdAt" - h1."createdAt")) * 1000 - $1) < 2000
  `, [FIVE_THIRTY_MS]);

  console.log(`Total duplicate (status, +5h30m) row pairs found: ${pairs.length}`);
  const affectedIssues = new Set(pairs.map((p) => p.key));
  console.log(`Distinct issues affected: ${affectedIssues.size}`);
  console.log('Sample affected issues:', [...affectedIssues].slice(0, 20));

  // Date range of the earlier (t1) side, to see if this clusters around a
  // specific import/migration event or is spread out / still happening.
  const { rows: range } = await pool.query(`
    SELECT MIN(h1."createdAt") AS earliest, MAX(h1."createdAt") AS latest
    FROM issue_history h1
    JOIN issue_history h2
      ON h2."issueId" = h1."issueId" AND h2.field = h1.field
     AND COALESCE(h2."oldValue", '') = COALESCE(h1."oldValue", '')
     AND COALESCE(h2."newValue", '') = COALESCE(h1."newValue", '')
     AND COALESCE(h2."authorName", '') = COALESCE(h1."authorName", '')
     AND h2.id > h1.id
    WHERE h1.field = 'status'
      AND ABS(EXTRACT(EPOCH FROM (h2."createdAt" - h1."createdAt")) * 1000 - $1) < 2000
  `, [FIVE_THIRTY_MS]);
  console.log('\nDate range of earlier-side rows:', range[0]);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
