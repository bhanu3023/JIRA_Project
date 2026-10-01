// One-off: applies the exact same backfill UPDATE the startup migration in
// jira-pg-api.ts runs, for the single straggler (SOPS-109) that landed with
// cf_key still NULL right after the last deploy's boot-time backfill ran --
// most likely inserted by a concurrent request at the exact moment the app
// booted, just after the backfill's UPDATE had already run. Safe to run any
// time: idempotent, only ever touches a row still missing cf_key.
//
// Usage: node fix-single-missing-cf-key.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('public.cf_key_seq') IS NULL THEN
        CREATE SEQUENCE cf_key_seq;
        PERFORM setval('cf_key_seq', (SELECT COALESCE(MAX(CAST(SUBSTRING(cf_key FROM 4) AS INTEGER)), 0) FROM issues WHERE cf_key LIKE 'CF-%'));
      END IF;
    END $$;
  `);
  const res = await pool.query(`UPDATE issues SET cf_key = 'CF-' || nextval('cf_key_seq') WHERE cf_key IS NULL RETURNING key, cf_key`);
  console.log(`Backfilled ${res.rowCount} row(s):`);
  for (const r of res.rows) console.log(`  ${r.key} -> ${r.cf_key}`);

  const { rows: remaining } = await pool.query(`SELECT COUNT(*) AS n FROM issues WHERE cf_key IS NULL`);
  console.log(`\nRemaining issues with cf_key IS NULL: ${remaining[0].n}`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
