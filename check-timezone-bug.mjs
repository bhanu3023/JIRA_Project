/**
 * check-timezone-bug.mjs
 * READ-ONLY (except one temp-safe write, see below). Confirms or refutes the
 * hypothesis that dept_sla_started_at=NOW() (raw SQL, used everywhere a
 * ticket enters/re-enters a department) is being stored shifted by the
 * database session's local timezone instead of true UTC, versus createdAt
 * (Prisma-managed) which is not.
 *
 * Checks:
 *  1. Column data types for dept_sla_started_at vs "createdAt" (timestamp
 *     without time zone vs timestamptz matters a lot here).
 *  2. The Postgres session's current `timezone` setting.
 *  3. A live round-trip: runs `SELECT NOW()` and `SELECT NOW() AT TIME ZONE
 *     'UTC'` side by side to show the actual gap.
 *  4. Node's own process timezone, for comparison.
 *
 * Run: DATABASE_URL=... node check-timezone-bug.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

async function main() {
  console.log('Node process timezone:', Intl.DateTimeFormat().resolvedOptions().timeZone, '| TZ env:', process.env.TZ || '(unset)');

  const tz = await pool.query(`SHOW timezone;`);
  console.log('\nPostgres session timezone setting:', tz.rows[0].TimeZone);

  const cols = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'issues' AND column_name IN ('dept_sla_started_at', 'createdAt', 'updatedAt', 'resolvedAt', 'dueDate')
    ORDER BY column_name
  `);
  console.log('\nColumn types on issues:');
  console.log(JSON.stringify(cols.rows, null, 2));

  const now = await pool.query(`SELECT NOW() AS raw_now, NOW() AT TIME ZONE 'UTC' AS now_as_utc, timezone('UTC', now()) AS now_via_timezone_fn`);
  console.log('\nLive NOW() comparison (run this and read the raw values carefully):');
  console.log(JSON.stringify(now.rows[0], null, 2));

  // Round-trip test: write NOW() into a scratch value via the exact same
  // raw-SQL pattern the app uses, then read it back both as a plain SELECT
  // and cast to timestamptz, to see exactly what gets stored vs what Node
  // will parse it as.
  await pool.query(`CREATE TEMP TABLE tz_probe (t1 TIMESTAMP, t2 TIMESTAMPTZ)`);
  await pool.query(`INSERT INTO tz_probe (t1, t2) VALUES (NOW(), NOW())`);
  const probe = await pool.query(`SELECT t1, t2, t1::text AS t1_text, t2::text AS t2_text FROM tz_probe`);
  console.log('\nRound-trip probe (t1 = TIMESTAMP without tz, t2 = TIMESTAMPTZ, both inserted via NOW() in the same statement):');
  console.log(JSON.stringify(probe.rows[0], null, 2));
  console.log('t1 (as Date via node-postgres):', new Date(probe.rows[0].t1).toISOString());
  console.log('t2 (as Date via node-postgres):', new Date(probe.rows[0].t2).toISOString());
  console.log('If t1 and t2 differ when both were inserted via NOW() in the same instant, dept_sla_started_at (if it is a plain TIMESTAMP column) is being shifted by the session timezone above.');

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
