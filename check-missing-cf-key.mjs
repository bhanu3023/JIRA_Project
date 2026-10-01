// Counts how many issues are missing a cf_key (the clean CF-#### display
// key) -- these fall back to showing their raw internal project key
// (L1BOAR-N, L2B-N, etc.) everywhere the UI expects cf_key, which is what
// check-sla-breach-accuracy.mjs's Migration output surfaced (67 tickets
// like "L1BOAR-6602" instead of a CF- key). Run BEFORE deploying the
// startup backfill in jira-pg-api.ts to see the real scope, and again
// AFTER to confirm it caught everything (should read 0 the second time).
//
// Read-only.
//
// Usage: node check-missing-cf-key.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: totalRows } = await pool.query(`SELECT COUNT(*) AS n FROM issues WHERE cf_key IS NULL`);
  console.log(`Total issues with cf_key IS NULL: ${totalRows[0].n}`);

  const { rows: byPrefix } = await pool.query(`
    SELECT SPLIT_PART(key, '-', 1) AS prefix, COUNT(*) AS n
    FROM issues WHERE cf_key IS NULL
    GROUP BY prefix ORDER BY n DESC
  `);
  console.log('\nBy internal key prefix:');
  for (const r of byPrefix) console.log(`  ${r.prefix}: ${r.n}`);

  const { rows: recent } = await pool.query(`
    SELECT key, "createdAt" FROM issues WHERE cf_key IS NULL ORDER BY "createdAt" DESC LIMIT 5
  `);
  console.log('\nMost recently created among them (checks whether this is only old/migrated data, or still happening on new tickets):');
  for (const r of recent) console.log(`  ${r.key}  createdAt=${r.createdAt.toISOString()}`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
