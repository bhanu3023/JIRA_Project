// The general branch's new orderBy: [{status:{category:'desc'}}, ...]
// fix relies on 'done' being alphabetically the LOWEST real category
// value in this system (so DESC puts it last). Confirmed against Dev
// queue's sample (done/todo/in-progress/in_progress), but checking every
// distinct category value across the whole database before trusting
// that assumption generally -- a category like "archived" or "cancelled"
// would sort before "done" and break this.
//
// Read-only.
//
// Usage: node check-all-status-category-values.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT DISTINCT category FROM statuses ORDER BY category`
  );
  console.log('Distinct status categories across the whole system:');
  for (const r of rows) console.log(`  "${r.category}"`);

  const sorted = rows.map(r => r.category).sort();
  console.log('\nAlphabetical order:', sorted.join(' < '));
  console.log(`\n'done' is alphabetically first: ${sorted[0] === 'done' ? 'YES -- assumption holds' : 'NO -- assumption BROKEN, fix needs revisiting'}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
