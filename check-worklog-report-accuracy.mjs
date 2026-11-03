// Read-only: the Worklog report's date-range filter does
//   wl."workDate" >= $from  AND  wl."workDate" <= $to
// where `from`/`to` come from the frontend as plain date strings
// (e.g. "2026-11-03"), which JS parses as MIDNIGHT UTC of that day.
// workDate itself is a TIMESTAMPTZ defaulting to new Date() (the real
// moment someone logged the work, not midnight) whenever the submitter
// didn't pick a specific work date. If that's true, "<=" against midnight
// of the END date would silently exclude almost every entry actually
// logged ON that end date (since very few land exactly at 00:00:00 UTC).
// Check real data to confirm or rule this out.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: sample } = await pool.query(`
    SELECT "workDate", "createdAt" FROM issue_worklogs ORDER BY "createdAt" DESC LIMIT 15
  `);
  console.log('Sample of recent workDate vs createdAt (to see if workDate carries real time-of-day or just midnight):');
  for (const r of sample) console.log(`  workDate=${r.workDate.toISOString()}  createdAt=${r.createdAt.toISOString()}`);

  const { rows: midnightCount } = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM "workDate") = 0 AND EXTRACT(MINUTE FROM "workDate") = 0 AND EXTRACT(SECOND FROM "workDate") = 0) AS at_midnight,
           COUNT(*) AS total
    FROM issue_worklogs
  `);
  console.log(`\nEntries with workDate exactly at midnight UTC: ${midnightCount[0].at_midnight} / ${midnightCount[0].total}`);

  // Reproduce the exact report query for the range shown in the screenshot
  // (From 2026-10-05 To 2026-11-03), the way the frontend's date strings
  // get parsed, and compare against a genuinely inclusive end-of-day version.
  const from = new Date('2026-10-05');
  const toNaive = new Date('2026-11-03'); // what the current code does
  const toInclusive = new Date('2026-11-03T23:59:59.999Z'); // genuinely "through end of Nov 3"

  const { rows: naive } = await pool.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM("timeSpentMinutes"),0) AS mins FROM issue_worklogs WHERE "workDate" >= $1 AND "workDate" <= $2`,
    [from, toNaive]
  );
  const { rows: inclusive } = await pool.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM("timeSpentMinutes"),0) AS mins FROM issue_worklogs WHERE "workDate" >= $1 AND "workDate" <= $2`,
    [from, toInclusive]
  );

  console.log(`\nCurrent (naive midnight) "To" boundary:   ${naive[0].cnt} entries, ${(naive[0].mins/60).toFixed(1)}h`);
  console.log(`Genuinely inclusive end-of-day "To":       ${inclusive[0].cnt} entries, ${(inclusive[0].mins/60).toFixed(1)}h`);
  console.log(`Difference (entries silently excluded by the current "To" boundary): ${inclusive[0].cnt - naive[0].cnt} entries, ${((inclusive[0].mins - naive[0].mins)/60).toFixed(1)}h`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
