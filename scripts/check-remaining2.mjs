import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

for (const dept of ['Infra', 'QA', 'Pre-Sales', 'SalesOps', 'Dev']) {
  const r = await pool.query(`
    SELECT key, summary FROM issues
    WHERE ("productType" IS NULL OR "productType" = '' OR "productType" = 'null')
      AND current_department = $1
    LIMIT 30
  `, [dept]);
  console.log(`\n=== ${dept} (${r.rows.length} sample) ===`);
  r.rows.forEach(t => console.log(`  ${t.key}: ${(t.summary||'').slice(0,90)}`));
}

// Also check what productType filled Migration tickets have most
const migPT = await pool.query(`
  SELECT "productType", COUNT(*) cnt FROM issues
  WHERE current_department = 'Migration'
    AND "productType" IS NOT NULL AND "productType" != '' AND "productType" != 'null'
  GROUP BY "productType" ORDER BY cnt DESC
`);
console.log('\n=== Migration filled productType breakdown ===');
migPT.rows.forEach(r => console.log(`  ${r.productType}: ${r.cnt}`));

await pool.end();
