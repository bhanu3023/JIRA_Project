import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

// Overall coverage for Migration dept
const cov = await pool.query(`
  SELECT
    COUNT(*) total,
    COUNT(CASE WHEN "productType" IS NULL OR "productType"='' OR "productType"='null' THEN 1 END) missing_pt,
    COUNT(CASE WHEN "projectManager" IS NULL OR "projectManager"='' OR "projectManager"='null' THEN 1 END) missing_pm,
    COUNT(CASE WHEN combination IS NULL OR combination='' OR combination='null' THEN 1 END) missing_combo,
    COUNT(CASE WHEN ("productType" IS NULL OR "productType"='' OR "productType"='null')
               AND ("projectManager" IS NULL OR "projectManager"='' OR "projectManager"='null')
               AND (combination IS NULL OR combination='' OR combination='null') THEN 1 END) missing_all_three
  FROM issues WHERE current_department = 'Migration'
`);
const c = cov.rows[0];
console.log('=== Migration Queue Coverage ===');
console.log(`Total:           ${c.total}`);
console.log(`Missing PT:      ${c.missing_pt}`);
console.log(`Missing PM:      ${c.missing_pm}`);
console.log(`Missing combo:   ${c.missing_combo}`);
console.log(`Missing all 3:   ${c.missing_all_three}`);

// Sample missing PM
const missingPM = await pool.query(`
  SELECT key, cf_key, summary, "customerName", combination, "projectManager", "productType"
  FROM issues WHERE current_department = 'Migration'
    AND ("projectManager" IS NULL OR "projectManager"='' OR "projectManager"='null')
  LIMIT 20
`);
console.log(`\nSample tickets missing PM (${missingPM.rows.length} shown):`);
missingPM.rows.forEach(t => console.log(`  ${t.key} | cf_key=${t.cf_key} | cust="${t.customerName}" | combo="${t.combination}" | ${(t.summary||'').slice(0,60)}`));

// Sample missing combo
const missingCombo = await pool.query(`
  SELECT key, cf_key, summary, "customerName", combination, "projectManager"
  FROM issues WHERE current_department = 'Migration'
    AND (combination IS NULL OR combination='' OR combination='null')
  LIMIT 20
`);
console.log(`\nSample tickets missing Combination (${missingCombo.rows.length} shown):`);
missingCombo.rows.forEach(t => console.log(`  ${t.key} | cf_key=${t.cf_key} | cust="${t.customerName}" | PM="${t.projectManager}" | ${(t.summary||'').slice(0,60)}`));

// Check what the latest Migration tickets are (by key number)
const latest = await pool.query(`
  SELECT key, cf_key, summary, "productType", "projectManager", combination, "createdAt"
  FROM issues WHERE current_department = 'Migration'
  ORDER BY "createdAt" DESC LIMIT 20
`);
console.log('\nLatest 20 Migration tickets:');
latest.rows.forEach(t => console.log(`  ${t.key} | cf=${t.cf_key} | PT="${t.productType||'-'}" | PM="${t.projectManager||'-'}" | combo="${t.combination||'-'}" | ${(t.summary||'').slice(0,50)}`));

// Check CFITSA tickets (cf_key like CFITS-XXXX or space key CFITSA)
const cfitsaCheck = await pool.query(`
  SELECT COUNT(*) cnt FROM issues
  WHERE (cf_key LIKE 'CFITSA-%' OR cf_key LIKE 'CFITS-%' OR key LIKE 'CFITSA-%')
    AND current_department = 'Migration'
`);
console.log(`\nMigration tickets with CFITSA cf_key: ${cfitsaCheck.rows[0].cnt}`);

// What's the max L1BOAR number in DB?
const maxKey = await pool.query(`
  SELECT MAX(CAST(SPLIT_PART(key, '-', 2) AS INTEGER)) max_num
  FROM issues WHERE key LIKE 'L1BOAR-%'
`);
console.log(`Max L1BOAR key in DB: L1BOAR-${maxKey.rows[0].max_num}`);

await pool.end();
