// 77 of 95 Cloudsoft-mentioning tickets have customerName=NULL. Checking
// two things before writing any fix: (1) are these disproportionately
// Jira-imported tickets (jira_source_key set) -- i.e. did the import ever
// have a customer value for them that just wasn't mapped into
// customerName, possibly landing in a different field instead (clientName,
// manageClientName, customerPlan)? (2) does merging clientName into the
// Customer Name filter's matching actually help for THIS customer, or is
// clientName genuinely empty for all of them too (in which case that part
// of the fix wouldn't change anything for Cloudsoft specifically, even if
// it's still a reasonable general improvement).
//
// Read-only.
//
// Usage: node check-cloudsoft-jira-import-fields.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT COALESCE(cf_key, key) AS key, jira_source_key, "clientName", "manageClientName", "customerPlan"
     FROM issues
     WHERE summary ILIKE '%cloudsoft%' AND "customerName" IS NULL`
  );
  console.log(`Tickets with "cloudsoft" (exact word) in summary and customerName=NULL: ${rows.length}`);

  let jiraImported = 0, hasClientName = 0, hasManageClientName = 0, hasCustomerPlan = 0;
  for (const r of rows) {
    if (r.jira_source_key) jiraImported++;
    if (r.clientName) hasClientName++;
    if (r.manageClientName) hasManageClientName++;
    if (r.customerPlan) hasCustomerPlan++;
  }
  console.log(`  jira_source_key set (imported from Jira): ${jiraImported}`);
  console.log(`  clientName set (non-null): ${hasClientName}`);
  console.log(`  manageClientName set (non-null): ${hasManageClientName}`);
  console.log(`  customerPlan set (non-null): ${hasCustomerPlan}`);

  console.log('\nFirst 10 rows in full:');
  for (const r of rows.slice(0, 10)) {
    console.log(`  ${r.key}  jira_source_key=${r.jira_source_key ?? 'null'}  clientName=${r.clientName ?? 'null'}  manageClientName=${r.manageClientName ?? 'null'}  customerPlan=${r.customerPlan ?? 'null'}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
