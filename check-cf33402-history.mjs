// Read-only check: was CF-33402 ever created and then deleted (deleted_issues
// keeps who/when), or was that key number simply never assigned at all?
//
// Usage: node check-cf33402-history.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'CF-33402';

async function main() {
  const { rows: delRows } = await pool.query(
    `SELECT id, key, cf_key, space_key, summary, deleted_by_name, deleted_at FROM deleted_issues WHERE key = $1 OR cf_key = $1`,
    [KEY]
  );
  if (delRows.length) {
    console.log(`Found in deleted_issues (was created, then deleted):`);
    for (const r of delRows) console.log(r);
  } else {
    console.log(`Not found in deleted_issues -- was never created and deleted via the app's own delete action.`);
  }

  // Show the CF numbers immediately around it to see if this was a genuine
  // gap in the sequence (e.g. a failed/rolled-back creation) or if nearby
  // numbers simply don't exist either for some other reason.
  const { rows: neighbors } = await pool.query(
    `SELECT cf_key, key, "createdAt" FROM issues WHERE cf_key ~ '^CF-\\d+$' AND substring(cf_key from 4)::int BETWEEN 33395 AND 33410 ORDER BY substring(cf_key from 4)::int ASC`
  );
  console.log(`\nNearby CF numbers that DO exist (33395-33410):`);
  for (const r of neighbors) console.log(`  ${r.cf_key}  created=${r.createdAt?.toISOString?.() || r.createdAt}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
