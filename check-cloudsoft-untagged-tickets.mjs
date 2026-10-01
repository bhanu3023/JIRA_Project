// customerName='cloudsoft' is confirmed clean (16 tickets, no case
// fragmentation). But ticket summaries clearly reference "Cloudsoft" in
// free text -- checking whether there are MORE tickets that mention
// Cloudsoft in their summary but never got the structured Customer Name
// field filled in at all (customerName IS NULL or something else
// entirely), which would explain "only 16" feeling too low without it
// being a filter bug.
//
// Read-only.
//
// Usage: node check-cloudsoft-untagged-tickets.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: totalMentions } = await pool.query(
    `SELECT COUNT(*) FROM issues WHERE summary ILIKE '%cloud%soft%'`
  );
  console.log(`Tickets whose SUMMARY mentions "cloud...soft" (any spacing/case): ${totalMentions[0].count}`);

  const { rows: byCustomerName } = await pool.query(
    `SELECT COALESCE("customerName", '(none set)') AS cn, COUNT(*) AS cnt
     FROM issues WHERE summary ILIKE '%cloud%soft%'
     GROUP BY "customerName" ORDER BY cnt DESC`
  );
  console.log('\nOf those, broken down by their actual customerName field value:');
  for (const r of byCustomerName) console.log(`  customerName="${r.cn}": ${r.cnt}`);

  // Sample a few of the "untagged" ones so we can see real examples
  const { rows: samples } = await pool.query(
    `SELECT COALESCE(cf_key, key) AS key, summary, "customerName"
     FROM issues WHERE summary ILIKE '%cloud%soft%' AND ("customerName" IS NULL OR "customerName" != 'cloudsoft')
     ORDER BY "createdAt" DESC LIMIT 15`
  );
  console.log('\nSample of Cloudsoft-mentioning tickets NOT tagged customerName=cloudsoft:');
  for (const r of samples) console.log(`  ${r.key} [customerName=${r.customerName ?? 'NULL'}]: ${r.summary}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
