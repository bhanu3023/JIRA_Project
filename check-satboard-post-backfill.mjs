// After running fix-space-member-roles.mjs --apply, the People & Access page
// for SAT_Board still shows "Admin" for Abhinav Surattu, Anush Dasari, and
// Manmadha Jayamangala (per screenshot), even though the backfill's own
// printed list said it updated all 9 SB rows including these three. Checking
// whether the DB write actually took for these specific rows (real bug) or
// whether the value is correct now and the browser is just showing stale
// state from before the backfill ran (needs a refresh) -- also checking for
// duplicate space_members rows for the same (spaceId,userId) pair, which
// would explain a subset landing on a different, unexpected row.
//
// Read-only.
//
// Usage: node check-satboard-post-backfill.mjs
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT sm.id, sm.role, sm."userId", u."firstName", u."lastName", u.email
     FROM space_members sm JOIN spaces sp ON sp.id = sm."spaceId" JOIN users u ON u.id = sm."userId"
     WHERE sp.key = 'SB' ORDER BY u."firstName"`
  );
  console.log(`SB space_members: ${rows.length} rows`);
  for (const r of rows) console.log(`  id=${r.id}  role="${r.role}"  ${r.firstName} ${r.lastName} <${r.email}>`);

  // Check for duplicate (spaceId,userId) pairs across the whole table (shouldn't be possible given the @@unique, but confirming).
  const { rows: dupes } = await pool.query(
    `SELECT "spaceId", "userId", COUNT(*) FROM space_members GROUP BY "spaceId", "userId" HAVING COUNT(*) > 1`
  );
  console.log(`\nDuplicate (spaceId,userId) pairs: ${dupes.length}`);
  for (const d of dupes) console.log(' ', d);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
