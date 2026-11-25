// Read-only: confirm the 25 requested tickets are actually gone from `issues`
// and are present in `deleted_issues` (so they're genuinely deleted AND
// recoverable), rather than trusting the delete script's own printed output.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const KEYS = [
  'CF-9889', 'CF-10256', 'CF-10426', 'CF-14614', 'CF-14921', 'CF-14951', 'CF-14986',
  'CF-18386', 'CF-19061', 'CF-19328', 'CF-19362', 'CF-19369', 'CF-19862', 'CF-20168',
  'CF-22183', 'CF-24400', 'CF-24430', 'CF-24990', 'CF-25059', 'CF-25121', 'CF-25171',
  'CF-25172', 'CF-25292', 'CF-27197', 'CF-30003',
];

async function main() {
  const { rows: stillExist } = await pool.query(
    `SELECT key, cf_key FROM issues WHERE key = ANY($1::text[]) OR cf_key = ANY($1::text[])`,
    [KEYS],
  );
  const { rows: trashed } = await pool.query(
    `SELECT key, cf_key, deleted_at FROM deleted_issues WHERE key = ANY($1::text[]) OR cf_key = ANY($1::text[])`,
    [KEYS],
  );
  const trashedKeys = new Set(trashed.map((r) => r.cf_key || r.key));

  if (stillExist.length) {
    console.log(`STILL IN issues (NOT deleted): ${stillExist.map((r) => r.cf_key || r.key).join(', ')}`);
  } else {
    console.log('None of the 25 keys remain in `issues` -- confirmed gone from the live table.');
  }

  for (const k of KEYS) {
    console.log(`${k}: ${trashedKeys.has(k) ? `in trash (deleted_issues)` : 'NOT FOUND IN TRASH'}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
