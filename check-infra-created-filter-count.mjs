// User says Queue: Infra + "Created: More than 1 day ago" showing 3,303
// is "not at all correct". Checking the real DB count independently to
// confirm whether 3,303 is actually accurate for this exact criterion
// (a ticket currently in Infra, created before 1 day ago -- no upper
// bound, by definition an extremely broad filter). Read-only.
//
// Usage: node check-infra-created-filter-count.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: sp } = await pool.query(`SELECT id FROM spaces WHERE key = 'TESTIN'`);
  const spaceId = sp[0]?.id;

  const { rows: total } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM issues WHERE "spaceId" = $1 AND LOWER(current_department) = 'infra'`,
    [spaceId]
  );
  console.log(`All tickets currently in Infra (no date filter): ${total[0].cnt}`);

  const { rows: createdFilter } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM issues
     WHERE "spaceId" = $1 AND LOWER(current_department) = 'infra'
       AND "createdAt" <= NOW() - INTERVAL '1 day'`,
    [spaceId]
  );
  console.log(`Currently in Infra AND created more than 1 day ago: ${createdFilter[0].cnt}`);

  const { rows: recentOnly } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM issues
     WHERE "spaceId" = $1 AND LOWER(current_department) = 'infra'
       AND "createdAt" > NOW() - INTERVAL '1 day'`,
    [spaceId]
  );
  console.log(`Currently in Infra AND created within the last 1 day (the complement): ${recentOnly[0].cnt}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
