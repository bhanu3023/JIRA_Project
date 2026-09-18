// CF-26919: sets updatedAt to match resolvedAt per explicit request
// (currently updatedAt is ~24 days after resolvedAt).
//
// Usage: node fix-cf26919-updated-date.mjs [--apply]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(
    `SELECT id, "resolvedAt", "updatedAt" FROM issues WHERE cf_key = 'CF-26919' OR key = 'CF-26919'`
  );
  const issue = rows[0];
  console.log(`Current: resolvedAt=${issue.resolvedAt?.toISOString()}  updatedAt=${issue.updatedAt?.toISOString()}`);
  console.log(`${APPLY ? 'Setting' : 'Would set'} updatedAt = resolvedAt`);
  if (APPLY) {
    await pool.query(`UPDATE issues SET "updatedAt" = "resolvedAt" WHERE id = $1`, [issue.id]);
    console.log('Applied.');
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
