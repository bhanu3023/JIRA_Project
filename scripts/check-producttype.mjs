import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

const r = await pool.query(`
  SELECT "productType", COUNT(*) cnt
  FROM issues
  WHERE "productType" IS NOT NULL AND "productType" != '' AND "productType" != 'null'
  GROUP BY "productType" ORDER BY cnt DESC LIMIT 30
`);
console.log('Distinct productType values:');
r.rows.forEach(x => console.log(`  "${x.productType}" — ${x.cnt}`));

const missing = await pool.query(`
  SELECT COUNT(*) total,
    COUNT(CASE WHEN "productType" IS NULL OR "productType"='' OR "productType"='null' THEN 1 END) missing
  FROM issues
`);
console.log(`\nTotal: ${missing.rows[0].total} | Missing productType: ${missing.rows[0].missing}`);

// Check by dept
const byDept = await pool.query(`
  SELECT current_department, COUNT(*) total,
    COUNT(CASE WHEN "productType" IS NULL OR "productType"='' OR "productType"='null' THEN 1 END) missing
  FROM issues
  WHERE current_department IS NOT NULL
  GROUP BY current_department ORDER BY total DESC LIMIT 10
`);
console.log('\nBy department:');
byDept.rows.forEach(x => console.log(`  ${x.current_department}: total=${x.total} missing=${x.missing}`));

await pool.end();
