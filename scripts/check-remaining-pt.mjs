import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

// Check remaining missing
const remaining = (await pool.query(`
  SELECT id, key, cf_key, summary, combination, "customerName", current_department, "projectManager"
  FROM issues
  WHERE "productType" IS NULL OR "productType" = '' OR "productType" = 'null'
  LIMIT 5000
`)).rows;
console.log(`Still missing: ${remaining.length} (sample of 5000)\n`);

// Dept breakdown of remaining
const deptQ = await pool.query(`
  SELECT current_department, COUNT(*) cnt
  FROM issues
  WHERE ("productType" IS NULL OR "productType" = '' OR "productType" = 'null')
  GROUP BY current_department ORDER BY cnt DESC LIMIT 15
`);
console.log('By dept:');
deptQ.rows.forEach(r => console.log(`  ${r.current_department || '(none)'}: ${r.cnt}`));

// How many have combination set
const withCombo = remaining.filter(t => t.combination && t.combination !== 'null' && t.combination !== '');
console.log(`\nHave combination: ${withCombo.length}`);

// How many have customerName set
const withCust = remaining.filter(t => t.customerName && t.customerName !== 'null' && t.customerName !== '');
console.log(`Have customerName: ${withCust.length}`);

// Sample summaries of remaining (no combination, no customerName)
const bare = remaining.filter(t =>
  (!t.combination || t.combination === 'null' || t.combination === '') &&
  (!t.customerName || t.customerName === 'null' || t.customerName === '')
);
console.log(`Have neither (bare): ${bare.length}`);
console.log('\nSample bare summaries:');
bare.slice(0, 30).forEach(t => console.log(`  [${t.current_department}] ${t.key}: ${(t.summary || '').slice(0, 80)}`));

// Sample summaries of those with customerName but no combo
const custOnly = remaining.filter(t =>
  (!t.combination || t.combination === 'null' || t.combination === '') &&
  (t.customerName && t.customerName !== 'null' && t.customerName !== '')
);
console.log(`\nHave customerName but no combo: ${custOnly.length}`);
console.log('Sample:');
custOnly.slice(0, 20).forEach(t => console.log(`  [${t.current_department}] ${t.key} | cust="${t.customerName}" | ${(t.summary || '').slice(0, 60)}`));

// Sample with combo that keywords didn't catch
const comboLeft = remaining.filter(t => t.combination && t.combination !== 'null' && t.combination !== '');
console.log(`\nHave combo but no PT matched: ${comboLeft.length}`);
console.log('Distinct combos:');
const comboCount = {};
for (const t of comboLeft) comboCount[t.combination] = (comboCount[t.combination] || 0) + 1;
Object.entries(comboCount).sort((a,b)=>b[1]-a[1]).slice(0, 30).forEach(([c, n]) => console.log(`  "${c}": ${n}`));

await pool.end();
