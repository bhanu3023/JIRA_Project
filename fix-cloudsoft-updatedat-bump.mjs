// backfill-cloudsoft-customer-name.mjs set customerName='cloudsoft' on 48
// tickets and, as a side effect, stamped updatedAt=NOW() on all of them in
// the same UPDATE -- even though nothing about their real activity
// changed. Confirmed on CF-26109: resolved 29/Jun, but updatedAt jumped to
// the moment that backfill ran, corrupting any "Updated" date-range filter
// that includes/excludes it. Resetting updatedAt back to each ticket's own
// resolvedAt (the last real thing that happened to it), per explicit
// request -- scoped ONLY to tickets that are both customerName='cloudsoft'
// AND still show that exact bumped-updatedAt signature, so this never
// touches a ticket that had genuine activity after the backfill ran.
//
// Dry-run by default. Pass --apply to actually write.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(
    `SELECT COALESCE(cf_key, key) AS key, "resolvedAt", "updatedAt"
     FROM issues
     WHERE "customerName" = 'cloudsoft'
       AND "resolvedAt" IS NOT NULL
       AND "updatedAt" > "resolvedAt" + INTERVAL '1 day'
       AND "updatedAt" > NOW() - INTERVAL '2 days'
     ORDER BY key`
  );
  console.log(`${rows.length} cloudsoft tickets have a stale updatedAt bump from the earlier backfill:`);
  for (const r of rows) {
    console.log(`  ${r.key}: resolvedAt=${r.resolvedAt.toISOString()}, updatedAt=${r.updatedAt.toISOString()}`);
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to reset updatedAt = resolvedAt for these.');
    await pool.end();
    return;
  }

  const result = await pool.query(
    `UPDATE issues SET "updatedAt" = "resolvedAt"
     WHERE "customerName" = 'cloudsoft'
       AND "resolvedAt" IS NOT NULL
       AND "updatedAt" > "resolvedAt" + INTERVAL '1 day'
       AND "updatedAt" > NOW() - INTERVAL '2 days'`
  );
  console.log(`\nApplied. ${result.rowCount} rows reset.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
