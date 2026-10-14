// Read-only check: does CF-33402 exist in the DB at all? If it does, the
// "Issue not found" in the UI is a real bug (likely a server-side error
// being swallowed and reported as 404) -- if it doesn't, that's a genuine
// bad/mistyped ticket number, not a bug.
//
// Usage: node check-cf33402.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'CF-33402';

async function main() {
  const { rows } = await pool.query(`SELECT id, key, cf_key, current_department, "spaceId" FROM issues WHERE key = $1 OR cf_key = $1 LIMIT 1`, [KEY]);
  if (!rows.length) {
    console.log(`${KEY} does NOT exist in the issues table.`);
  } else {
    console.log(`${KEY} EXISTS:`, rows[0]);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
