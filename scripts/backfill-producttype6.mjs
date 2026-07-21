import pg from 'pg';
const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) console.log('DRY RUN — pass --apply to write changes\n');

const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

const all = (await pool.query(`SELECT id, key, cf_key, summary, "productType", combination, "customerName", current_department FROM issues`)).rows;
const missing = all.filter(t => !t.productType || t.productType === 'null' || t.productType === '');
console.log(`Still missing: ${missing.length}`);
const devMissing = missing.filter(t => t.current_department === 'Dev');
console.log(`Dev missing: ${devMissing.length}\n`);

// ── Customer lookup ───────────────────────────────────────────────────────
function extractCusts(s) {
  if (!s) return [];
  const results = [];
  const m1 = s.match(/^([^|\-]{2,40?})\s*[\-|]/);
  if (m1) results.push(m1[1].trim().toLowerCase());
  const parts = s.split(/\s*\|\s*/);
  if (parts.length > 1) results.push(parts[0].trim().toLowerCase());
  return results.filter(c => c.length > 2 && !/fw:|re:|fwd:/.test(c));
}
const custPT = new Map();
for (const t of all) {
  if (!t.productType || t.productType === 'null') continue;
  for (const cust of [(t.customerName||'').trim().toLowerCase(), ...extractCusts(t.summary)]) {
    if (!cust || cust === 'null' || cust.length < 2) continue;
    if (!custPT.has(cust)) custPT.set(cust, new Map());
    custPT.get(cust).set(t.productType, (custPT.get(cust).get(t.productType) || 0) + 1);
  }
}
const mostCommon = m => { let b = null, bc = 0; for (const [v, c] of m) if (c > bc) { b = v; bc = c; } return b; };

// ── Keyword signal for any remaining ──────────────────────────────────────
function ptSignal(s) {
  if (!s) return null;
  const t = s.toLowerCase();
  // Email-specific
  if (/\boutlook\b|\bexchange\b|\bgmail\b|\bpst\b|\bmailbox\b/.test(t)) return 'Email Migration';
  if (/calendar|attachment[s]?.*miss|mail[s]?.*duplicat|mail.*mismatch/.test(t)) return 'Email Migration';
  if (/archive.*migr|\bevent.*pick|pick.*event/.test(t)) return 'Email Migration';
  // Message-specific
  if (/\bs2c\b|\bt2t\b|\bchannel\b|\bslack\b|\bworkplace\b/.test(t)) return 'Message Migration';
  if (/conversation.*fail|delta.*message|message.*delta|no.?message.*state/.test(t)) return 'Message Migration';
  if (/\bchat\b.*destination|\bsticker\b/.test(t)) return 'Message Migration';
  // Content-specific
  if (/\bsharepoint\b|\bonedrive\b|\bgdrive\b|\bbox\b|\bdropbox\b/.test(t)) return 'Content Migration';
  if (/\bpermission\b|\bfolder\b|\bversion\b|\bhyperlink\b|\bcollab\b/.test(t)) return 'Content Migration';
  if (/\bwsid\b|\bworkspace\b/.test(t)) return 'Content Migration';
  if (/csv.*download|csv.*valid|layout.*miss|numbered.*list|bullet.*format/.test(t)) return 'Content Migration';
  if (/tenant.*tenant|o365|m365|spo\b/.test(t)) return 'Content Migration';
  return null;
}

let updates = [];
for (const t of devMissing) {
  let pt = null;

  // 1. Try customer cross-match
  for (const cust of [...extractCusts(t.summary), (t.customerName||'').trim().toLowerCase()]) {
    if (cust && cust.length > 2 && cust !== 'null' && custPT.has(cust)) {
      pt = mostCommon(custPT.get(cust));
      break;
    }
  }
  // 2. Keyword signal
  if (!pt) pt = ptSignal(t.summary);
  // 3. Final fallback: Content Migration (most common in Dev, and these are generic ops tasks)
  if (!pt) pt = 'Content Migration';

  updates.push({ id: t.id, key: t.key, pt, summary: (t.summary || '').slice(0, 70) });
}

console.log(`Would update: ${updates.length} Dev tickets\n`);
const byPT = {};
for (const u of updates) byPT[u.pt] = (byPT[u.pt] || 0) + 1;
Object.entries(byPT).sort((a,b)=>b[1]-a[1]).forEach(([pt,cnt]) => console.log(`  ${pt}: ${cnt}`));
console.log('\nSample fallback tickets (Content Migration default):');
updates.filter(u => u.pt === 'Content Migration').slice(0, 15).forEach(u => console.log(`  ${u.key}: ${u.summary}`));

if (!DRY_RUN && updates.length > 0) {
  console.log('\nApplying...');
  let done = 0;
  for (const u of updates) {
    await pool.query(`UPDATE issues SET "productType" = $1 WHERE id = $2`, [u.pt, u.id]);
    done++;
    if (done % 2000 === 0) console.log(`  ${done}/${updates.length}...`);
  }
  console.log(`Done! Updated ${done} tickets.`);
} else if (DRY_RUN) {
  console.log('\nRun with --apply to write changes.');
}

await pool.end();
