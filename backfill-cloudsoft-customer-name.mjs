// 48 tickets clearly name "Cloudsoft" in their own summary but have
// customerName=NULL -- confirmed via check-cloudsoft-jira-import-fields.mjs
// that the customer info isn't hiding in any other field (clientName is
// just the internal cloudfuze.com domain for these, not the real
// customer). Sets customerName='cloudsoft' on exactly those tickets --
// matching the exact same lowercase value already used by the 16 tickets
// that DO have it set, so they all become one consistent, filterable group.
//
// Deliberately scoped to the precise substring "cloudsoft" (no wildcard
// gap between "cloud" and "soft"), same query already used to confirm
// these 48 are genuine references -- the looser "cloud...soft" pattern
// used earlier caught false positives like "CloudFuze ... Microsoft" that
// this does NOT match.
//
// Dry-run by default; pass --apply to actually write.
//
// Usage: node backfill-cloudsoft-customer-name.mjs [--apply]
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT COALESCE(cf_key, key) AS key, summary FROM issues
     WHERE summary ILIKE '%cloudsoft%' AND "customerName" IS NULL
     ORDER BY key`
  );
  console.log(`${rows.length} tickets would be set to customerName='cloudsoft':`);
  for (const r of rows) console.log(`  ${r.key}: ${r.summary}`);

  if (!APPLY) {
    console.log('\nDRY RUN -- no changes made. Re-run with --apply to actually write.');
    await pool.end();
    return;
  }

  const result = await pool.query(
    `UPDATE issues SET "customerName" = 'cloudsoft', "updatedAt" = NOW()
     WHERE summary ILIKE '%cloudsoft%' AND "customerName" IS NULL`
  );
  console.log(`\nApplied. ${result.rowCount} rows updated.`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
