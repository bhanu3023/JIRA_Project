// Read-only: confirms no U+FFFD remains in test_cases after fix-test-repo-fffd-chars.mjs --apply.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM test_cases WHERE summary LIKE '%' || $1 || '%' OR description LIKE '%' || $1 || '%' OR steps::text LIKE '%' || $1 || '%'`,
    ['�'],
  );
  console.log(`Remaining rows with U+FFFD: ${rows[0].n}`);
  const { rows: sample } = await pool.query(
    `SELECT "jiraKey", summary FROM test_cases WHERE "jiraKey" IN ('TEST-55452','TEST-55434','TEST-55442','TEST-55431','TEST-55455')`,
  );
  for (const r of sample) console.log(`${r.jiraKey}: ${r.summary}`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
