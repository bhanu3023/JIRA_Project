// Read-only check of CF-34270's current department, to see why the Root
// Cause/Fix Description red-asterisk isn't showing -- the existing
// mandatory-field rule (getMissingCoreFields) only requires them while a
// ticket is currently in Dev, and the asterisk was wired to that exact
// same condition.
//
// Usage: node check-cf34270-dept.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'CF-34270';

async function main() {
  const { rows } = await pool.query(`
    SELECT key, cf_key, current_department, "rootCause", "fixDescription", s.category, s.name AS status_name
    FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE i.key = $1 OR i.cf_key = $1 LIMIT 1
  `, [KEY]);
  console.log(rows[0]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
