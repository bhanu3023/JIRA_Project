import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

// 1. What CFITS/CFITSA tickets exist in issues table?
const cfitsSpaces = await pool.query(`
  SELECT DISTINCT LEFT(key, POSITION('-' IN key) - 1) space_prefix, COUNT(*) cnt
  FROM issues WHERE key LIKE 'CF-%' OR key LIKE 'CFITS%'
  GROUP BY 1 ORDER BY cnt DESC LIMIT 10
`);
console.log('CFITS-like spaces in issues table:');
cfitsSpaces.rows.forEach(r => console.log(`  ${r.space_prefix}: ${r.cnt}`));

// 2. What's max CF key number in DB?
const maxCF = await pool.query(`
  SELECT MAX(CAST(SPLIT_PART(key, '-', 2) AS INTEGER)) max_num
  FROM issues WHERE key LIKE 'CF-%'
`);
console.log(`\nMax CF key in DB: CF-${maxCF.rows[0].max_num}`);

// 3. What CF key range do Migration L1BOAR cf_keys cover?
const cfRange = await pool.query(`
  SELECT
    MIN(CAST(SPLIT_PART(cf_key, '-', 2) AS INTEGER)) min_cf,
    MAX(CAST(SPLIT_PART(cf_key, '-', 2) AS INTEGER)) max_cf,
    COUNT(*) cnt
  FROM issues
  WHERE current_department = 'Migration' AND cf_key LIKE 'CF-%'
`);
const r = cfRange.rows[0];
console.log(`\nMigration L1BOAR cf_keys range: CF-${r.min_cf} to CF-${r.max_cf} (${r.cnt} tickets)`);

// 4. Check if those CF keys exist in issues with PM/combo filled
const sampleCF = await pool.query(`
  SELECT i.key as l1boar, i.cf_key,
         c.key as cf_ticket, c."projectManager", c.combination, c."customerName"
  FROM issues i
  LEFT JOIN issues c ON c.key = i.cf_key
  WHERE i.current_department = 'Migration'
    AND (i."projectManager" IS NULL OR i."projectManager" = '' OR i."projectManager" = 'null')
    AND i.cf_key IS NOT NULL
  LIMIT 20
`);
console.log('\nMigration missing PM → lookup in CF tickets:');
sampleCF.rows.forEach(r => console.log(`  ${r.l1boar} cf_key=${r.cf_key} → CF exists=${r.cf_ticket || 'NOT FOUND'} | PM="${r.projectManager||'-'}" | combo="${r.combination||'-'}" | cust="${r.customerName||'-'}"`));

// 5. How many CF tickets exist for missing L1BOAR PM tickets?
const cfFound = await pool.query(`
  SELECT
    COUNT(*) total_missing,
    COUNT(c.key) cf_found,
    COUNT(CASE WHEN c."projectManager" IS NOT NULL AND c."projectManager" != '' AND c."projectManager" != 'null' THEN 1 END) cf_has_pm,
    COUNT(CASE WHEN c.combination IS NOT NULL AND c.combination != '' AND c.combination != 'null' THEN 1 END) cf_has_combo
  FROM issues i
  LEFT JOIN issues c ON c.key = i.cf_key
  WHERE i.current_department = 'Migration'
    AND (i."projectManager" IS NULL OR i."projectManager" = '' OR i."projectManager" = 'null')
`);
const cf = cfFound.rows[0];
console.log(`\nMissing PM tickets: ${cf.total_missing}`);
console.log(`  CF key found in DB: ${cf.cf_found}`);
console.log(`  CF ticket has PM:   ${cf.cf_has_pm}`);
console.log(`  CF ticket has combo: ${cf.cf_has_combo}`);

// 6. Check spaces table for CFITSA
const spaces = await pool.query(`SELECT key, name FROM spaces WHERE key ILIKE '%cfits%' OR name ILIKE '%cfits%' LIMIT 10`).catch(() => ({ rows: [] }));
console.log('\nSpaces with CFITS:');
spaces.rows.forEach(s => console.log(`  ${s.key}: ${s.name}`));

// 7. Latest CF tickets in DB vs latest L1BOAR cf_keys
const latestCF = await pool.query(`
  SELECT key, summary, "projectManager", combination, "customerName", "productType"
  FROM issues WHERE key LIKE 'CF-%'
  ORDER BY CAST(SPLIT_PART(key, '-', 2) AS INTEGER) DESC LIMIT 10
`);
console.log('\nLatest CF tickets in DB:');
latestCF.rows.forEach(t => console.log(`  ${t.key} | PT="${t.productType||'-'}" | PM="${t.projectManager||'-'}" | combo="${t.combination||'-'}" | ${(t.summary||'').slice(0,50)}`));

await pool.end();
