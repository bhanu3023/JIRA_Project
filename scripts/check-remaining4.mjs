import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

for (const dept of ['Dev', 'Infra', 'QA', 'Pre-Sales']) {
  const r = await pool.query(`
    SELECT key, summary FROM issues
    WHERE ("productType" IS NULL OR "productType" = '' OR "productType" = 'null')
      AND current_department = $1
    ORDER BY id DESC LIMIT 50
  `, [dept]);
  console.log(`\n=== ${dept} remaining ===`);
  r.rows.forEach(t => console.log(`  ${t.key}: ${(t.summary||'').slice(0,90)}`));
}

await pool.end();
