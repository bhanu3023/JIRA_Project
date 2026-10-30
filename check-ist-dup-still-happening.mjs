// Read-only: is the IST-offset duplicate-history bug still actively creating
// new duplicate pairs recently (e.g. in the last 7 days), or did it stop
// after some past change? Determines whether this needs an urgent code fix
// or just a one-time data cleanup.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const FIVE_THIRTY_MS = 5.5 * 60 * 60 * 1000;

async function main() {
  const { rows } = await pool.query(`
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
      AND h2."createdAt" > NOW() - INTERVAL '14 days'
    ORDER BY h2."createdAt" DESC
    LIMIT 30
  `, [FIVE_THIRTY_MS]);
  console.log(`Duplicate pairs where the LATER (duplicate) row was created in the last 14 days: ${rows.length}`);
  for (const r of rows) {
    console.log(` - ${r.key}: "${r.oldValue} -> ${r.newValue}" by ${r.authorName}  t1=${r.t1.toISOString()}  t2=${r.t2.toISOString()}`);
  }

  // Also: when was each half of the pair actually inserted into the DB
  // (createdAt is the event time, but these are likely backfilled -- check
  // the issue's own createdAt/updatedAt and the history row count to see if
  // this correlates with sync activity vs. a one-time import).
  const { rows: byMonth } = await pool.query(`
    SELECT date_trunc('month', h2."createdAt") AS month, COUNT(*) AS cnt
    FROM issue_history h1
    JOIN issue_history h2
      ON h2."issueId" = h1."issueId" AND h2.field = h1.field
     AND COALESCE(h2."oldValue", '') = COALESCE(h1."oldValue", '')
     AND COALESCE(h2."newValue", '') = COALESCE(h1."newValue", '')
     AND COALESCE(h2."authorName", '') = COALESCE(h1."authorName", '')
     AND h2.id > h1.id
    WHERE h1.field = 'status'
      AND ABS(EXTRACT(EPOCH FROM (h2."createdAt" - h1."createdAt")) * 1000 - $1) < 2000
    GROUP BY 1 ORDER BY 1
  `, [FIVE_THIRTY_MS]);
  console.log('\nDuplicate-pair count by month (of the later/duplicate row):');
  for (const r of byMonth) console.log(` - ${r.month.toISOString().slice(0, 7)}: ${r.cnt}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
