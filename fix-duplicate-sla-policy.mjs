/**
 * fix-duplicate-sla-policy.mjs
 * Deactivates the OLDER of the two duplicate "Time to Resolution" / Dev
 * policy rows found by verify-sla-fixes.mjs (ids pg_h1ifhuhw1i, pg_athlc8237e,
 * spaceId pg_92q07qtnlz) so only one active policy remains -- the app-side
 * dedup already picks the newest one at read time, so this just removes the
 * now-redundant duplicate at the source instead of relying on that dedup
 * forever. Soft-delete only (status='inactive'), nothing is deleted.
 *
 * DRY_RUN=true by default. Run: DATABASE_URL=... node fix-duplicate-sla-policy.mjs
 * Then for real:                DATABASE_URL=... DRY_RUN=false node fix-duplicate-sla-policy.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});
const DRY_RUN = process.env.DRY_RUN !== 'false';

async function main() {
  const r = await pool.query(
    `SELECT * FROM sla_definitions WHERE id IN ('pg_h1ifhuhw1i', 'pg_athlc8237e')`
  );
  if (r.rows.length !== 2) {
    console.log(`Expected 2 rows, found ${r.rows.length} -- re-run verify-sla-fixes.mjs to get current ids before proceeding.`);
    await pool.end();
    return;
  }
  const [a, b] = r.rows;
  console.log('Row A:', JSON.stringify({ id: a.id, name: a.name, dept_name: a.dept_name, status: a.status, updatedAt: a.updatedAt, createdAt: a.createdAt }, null, 2));
  console.log('Row B:', JSON.stringify({ id: b.id, name: b.name, dept_name: b.dept_name, status: b.status, updatedAt: b.updatedAt, createdAt: b.createdAt }, null, 2));

  const newer = new Date(a.updatedAt).getTime() >= new Date(b.updatedAt).getTime() ? a : b;
  const older = newer === a ? b : a;

  console.log(`\nKeeping (newer, active): ${newer.id} (updatedAt=${newer.updatedAt})`);
  console.log(`Deactivating (older, duplicate): ${older.id} (updatedAt=${older.updatedAt})`);

  if (DRY_RUN) {
    console.log('\nDRY RUN -- no changes made. Re-run with DRY_RUN=false to apply.');
    await pool.end();
    return;
  }

  await pool.query(`UPDATE sla_definitions SET status = 'inactive' WHERE id = $1`, [older.id]);
  console.log(`\nDone -- ${older.id} set to status='inactive'.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
