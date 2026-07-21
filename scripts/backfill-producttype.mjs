import pg from 'pg';
const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) console.log('DRY RUN — pass --apply to write changes\n');

const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

const all = (await pool.query(`SELECT id, key, cf_key, summary, "productType", combination, "customerName", current_department FROM issues`)).rows;
console.log(`Total: ${all.length}`);

const missing = all.filter(t => !t.productType || t.productType === 'null' || t.productType === '');
console.log(`Missing productType: ${missing.length}\n`);

// ── Lookup maps ────────────────────────────────────────────────────────────

// cf_key → productType
const cfPT = new Map();
for (const t of all) {
  if (!t.productType || t.productType === 'null') continue;
  const k = t.cf_key || t.key;
  if (k && !cfPT.has(k)) cfPT.set(k, t.productType);
}

// customerName → most common productType
const custPT = new Map();
for (const t of all) {
  if (!t.productType || t.productType === 'null') continue;
  const cust = (t.customerName || '').trim();
  if (!cust || cust === 'null') continue;
  if (!custPT.has(cust)) custPT.set(cust, new Map());
  const m = custPT.get(cust);
  m.set(t.productType, (m.get(t.productType) || 0) + 1);
}
const mostCommon = m => { let b = null, bc = 0; for (const [v, c] of m) if (c > bc) { b = v; bc = c; } return b; };

// combination → productType (deterministic)
function ptFromCombo(combo) {
  if (!combo || combo === 'null') return null;
  const c = combo.toLowerCase();
  if (/slack|teams.*chat|chat.*teams|s2t/.test(c)) return 'Message Migration';
  if (/gmail|exchange.*mail|mail.*exchange/.test(c)) return 'Email Migration';
  if (/box|dropbox|onedrive|sharepoint|mydrive|gdrive|google.*drive|nfs|drive/.test(c)) return 'Content Migration';
  if (/teams.*teams|teams to teams/.test(c)) return 'Message Migration';
  return null;
}

// summary keyword → productType
function ptFromSummary(summary) {
  if (!summary) return null;
  const s = summary.toLowerCase();
  if (/\bslack\b|\bs2t\b|teams.*migration|channel.*migr/.test(s)) return 'Message Migration';
  if (/\bgmail\b|\bexchange\b|email.*migr|migr.*email/.test(s)) return 'Email Migration';
  if (/\bbox\b|\bdropbox\b|\bonedrive\b|\bsharepoint\b|\bgdrive\b|google.*drive|content.*migr|file.*migr/.test(s)) return 'Content Migration';
  if (/cf.manage|cfmanage|manage.*board/.test(s)) return 'CF Manage';
  if (/message.*migr|migr.*message/.test(s)) return 'Message Migration';
  return null;
}

// ── Determine fill values ──────────────────────────────────────────────────
let updates = [];
for (const t of missing) {
  const k    = t.cf_key || t.key;
  const cust = (t.customerName || '').trim();
  let pt = null;

  // 1. cf_key cross-match
  if (!pt && k && cfPT.has(k)) pt = cfPT.get(k);
  // 2. customerName most-common
  if (!pt && cust && cust !== 'null' && custPT.has(cust)) pt = mostCommon(custPT.get(cust));
  // 3. combination-based
  if (!pt) pt = ptFromCombo(t.combination);
  // 4. summary keywords
  if (!pt) pt = ptFromSummary(t.summary);

  if (pt) updates.push({ id: t.id, key: k, pt, dept: t.current_department });
}

console.log(`Would update: ${updates.length} tickets\n`);

// Breakdown by productType
const byPT = {};
for (const u of updates) byPT[u.pt] = (byPT[u.pt] || 0) + 1;
Object.entries(byPT).sort((a,b) => b[1]-a[1]).forEach(([pt, cnt]) => console.log(`  ${pt}: ${cnt}`));

// Breakdown by dept
const byDept = {};
for (const u of updates) byDept[u.dept || '(none)'] = (byDept[u.dept || '(none)'] || 0) + 1;
console.log('\nBy dept:');
Object.entries(byDept).sort((a,b) => b[1]-a[1]).forEach(([d, cnt]) => console.log(`  ${d}: ${cnt}`));

// Preview
console.log('\nSample:');
updates.slice(0, 15).forEach(u => console.log(`  ${u.key} | dept="${u.dept}" → PT="${u.pt}"`));

if (!DRY_RUN && updates.length > 0) {
  console.log('\nApplying...');
  let done = 0;
  for (const u of updates) {
    await pool.query(`UPDATE issues SET "productType" = $1 WHERE id = $2`, [u.pt, u.id]);
    done++;
    if (done % 1000 === 0) console.log(`  ${done}/${updates.length}...`);
  }
  console.log(`Done! Updated ${done} tickets.`);
} else if (DRY_RUN) {
  console.log('\nRun with --apply to write changes.');
}

await pool.end();
