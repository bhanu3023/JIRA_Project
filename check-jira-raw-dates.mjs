// Checking whether the issues table has any raw jira_* timestamp
// columns (like jira_sla_due_at, jira_sla_start_at already seen
// elsewhere) that might have preserved the ORIGINAL Jira updated/
// created date separately from the live updatedAt column that's since
// been corrupted by old backfill scripts. If such a column exists and
// has real values, the true dates are recoverable, not lost. Read-only.
//
// Usage: node check-jira-raw-dates.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: cols } = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'issues' AND (column_name ILIKE '%jira%' OR column_name ILIKE '%updated%' OR column_name ILIKE '%created%')
    ORDER BY column_name
  `);
  console.log('All date-ish / jira-ish columns on issues table:');
  console.log(JSON.stringify(cols, null, 2));

  // Sample one of Kiran's affected tickets to see every one of these
  // columns' actual values
  const { rows: sample } = await pool.query(`
    SELECT * FROM issues WHERE cf_key = 'CF-18875' OR key = 'CF-18875' LIMIT 1
  `);
  if (sample.length) {
    const row = sample[0];
    const dateLike = {};
    for (const k of Object.keys(row)) {
      if (/jira|updated|created|date|At$/i.test(k)) dateLike[k] = row[k];
    }
    console.log('\nCF-18875 all date/jira-ish fields:', JSON.stringify(dateLike, null, 2));
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
