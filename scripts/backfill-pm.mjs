import pg from 'pg';
const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) console.log('DRY RUN — pass --apply to write changes\n');

const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

// All tickets
const all = (await pool.query(`SELECT id, key, cf_key, "customerName", "projectManager", combination, "assigneeId", "createdAt" FROM issues`)).rows;
console.log(`Total: ${all.length}`);

const missing = all.filter(t => !t.projectManager || t.projectManager === 'null' || t.projectManager === '');
console.log(`Missing PM: ${missing.length}\n`);

// Build: customerName → most common PM
const custPM = new Map(); // customerName → {pmName → count}
for (const t of all) {
  if (!t.projectManager || t.projectManager === 'null' || t.projectManager === '') continue;
  const cust = (t.customerName || '').trim();
  if (!cust || cust === 'null') continue;
  if (!custPM.has(cust)) custPM.set(cust, new Map());
  const m = custPM.get(cust);
  m.set(t.projectManager, (m.get(t.projectManager) || 0) + 1);
}
const mostCommon = m => { let b = null, bc = 0; for (const [v, c] of m) if (c > bc) { b = v; bc = c; } return b; };

// Build: cf_key → PM (from tickets that have it)
const cfPM = new Map();
for (const t of all) {
  if (!t.projectManager || t.projectManager === 'null' || t.projectManager === '') continue;
  const k = t.cf_key || t.key;
  if (k && !cfPM.has(k)) cfPM.set(k, t.projectManager);
}

// Build: combination → most common PM
const comboPM = new Map();
for (const t of all) {
  if (!t.projectManager || t.projectManager === 'null' || t.projectManager === '') continue;
  if (!t.combination || t.combination === 'null') continue;
  if (!comboPM.has(t.combination)) comboPM.set(t.combination, new Map());
  const m = comboPM.get(t.combination);
  m.set(t.projectManager, (m.get(t.projectManager) || 0) + 1);
}

let updates = [];
for (const t of missing) {
  const cust = (t.customerName || '').trim();
  const k    = t.cf_key || t.key;
  let pm = null;

  // 1. customer cross-match (most reliable)
  if (!pm && cust && cust !== 'null' && custPM.has(cust)) pm = mostCommon(custPM.get(cust));
  // 2. cf_key cross-match
  if (!pm && k && cfPM.has(k)) pm = cfPM.get(k);
  // 3. combination cross-match (most common PM for this migration type)
  if (!pm && t.combination && t.combination !== 'null' && comboPM.has(t.combination)) pm = mostCommon(comboPM.get(t.combination));

  if (pm) updates.push({ id: t.id, key: k, pm, cust, combo: t.combination });
}

console.log(`Would update: ${updates.length} tickets\n`);

// Show breakdown by PM
const byPM = {};
for (const u of updates) { byPM[u.pm] = (byPM[u.pm] || 0) + 1; }
Object.entries(byPM).sort((a,b) => b[1]-a[1]).forEach(([pm, cnt]) => console.log(`  ${pm}: ${cnt} tickets`));

// Preview first 20
console.log('\nSample:');
updates.slice(0, 20).forEach(u => console.log(`  ${u.key} | cust="${u.cust}" | combo="${u.combo}" → PM="${u.pm}"`));

if (!DRY_RUN && updates.length > 0) {
  console.log('\nApplying...');
  let done = 0;
  for (const u of updates) {
    await pool.query(`UPDATE issues SET "projectManager" = $1 WHERE id = $2`, [u.pm, u.id]);
    done++;
    if (done % 500 === 0) console.log(`  ${done}/${updates.length}...`);
  }
  console.log(`Done! Updated ${done} tickets.`);
} else if (DRY_RUN) {
  console.log('\nRun with --apply to write changes.');
}

await pool.end();
