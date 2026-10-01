// User filtered Filters' Customer Name to "cloudsoft" (one specific exact
// value from the dropdown, per the exact-match fix from earlier this
// session) and only got 16 results -- but ticket summaries visibly show
// "Cloudsoft", "CloudSoft", and "Cloud Soft" inconsistently, suggesting
// the underlying customerName column itself may have several distinct
// near-duplicate values for what's really the same customer. Checking
// directly instead of guessing.
//
// Read-only.
//
// Usage: node check-cloudsoft-customer-name-variants.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT "customerName", COUNT(*) AS cnt FROM issues
     WHERE "customerName" IS NOT NULL AND "customerName" ILIKE '%cloud%soft%'
     GROUP BY "customerName" ORDER BY cnt DESC`
  );
  console.log('All customerName values matching "cloud...soft" (any spacing/case):');
  let total = 0;
  for (const r of rows) { console.log(`  "${r.customerName}": ${r.cnt}`); total += Number(r.cnt); }
  console.log(`\nTotal across all variants: ${total}`);

  // Also check clientName in case the same fragmentation exists there
  const { rows: clientRows } = await pool.query(
    `SELECT "clientName", COUNT(*) AS cnt FROM issues
     WHERE "clientName" IS NOT NULL AND "clientName" ILIKE '%cloud%soft%'
     GROUP BY "clientName" ORDER BY cnt DESC`
  );
  console.log('\nAll clientName values matching "cloud...soft":');
  for (const r of clientRows) console.log(`  "${r.clientName}": ${r.cnt}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
