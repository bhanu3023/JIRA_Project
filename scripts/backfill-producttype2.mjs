import pg from 'pg';
const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) console.log('DRY RUN — pass --apply to write changes\n');

const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

const all = (await pool.query(`SELECT id, key, cf_key, summary, "productType", combination, "customerName", current_department FROM issues`)).rows;
console.log(`Total: ${all.length}`);

const missing = all.filter(t => !t.productType || t.productType === 'null' || t.productType === '');
console.log(`Still missing: ${missing.length}\n`);

// ── 1. Build customer → productType map from filled tickets ────────────────
// Also extract customer name from summary "CustomerName - ..." or "CustomerName | ..."
function extractCustFromSummary(s) {
  if (!s) return null;
  // "Este - Validation issue" → "Este"
  // "peak mining- T2T" → "peak mining"
  // "Market Cast | S2C" → "Market Cast"
  const m = s.match(/^([^|\-]{2,40?})\s*[\-|]/);
  return m ? m[1].trim().toLowerCase() : null;
}

const custPT = new Map(); // customerName.toLowerCase() → {pt → count}
for (const t of all) {
  if (!t.productType || t.productType === 'null') continue;
  // Try actual customerName field
  const cust = (t.customerName || '').trim().toLowerCase();
  if (cust && cust !== 'null') {
    if (!custPT.has(cust)) custPT.set(cust, new Map());
    const m = custPT.get(cust);
    m.set(t.productType, (m.get(t.productType) || 0) + 1);
  }
  // Also try extracted from summary
  const sumCust = extractCustFromSummary(t.summary);
  if (sumCust && sumCust.length > 2) {
    if (!custPT.has(sumCust)) custPT.set(sumCust, new Map());
    const m2 = custPT.get(sumCust);
    m2.set(t.productType, (m2.get(t.productType) || 0) + 1);
  }
}
const mostCommon = m => { let b = null, bc = 0; for (const [v, c] of m) if (c > bc) { b = v; bc = c; } return b; };

// ── 2. Department → productType (deterministic depts) ─────────────────────
const DEPT_PT = {
  'message-migration-backlog': 'Message Migration',
  'email-migration-backlog': 'Email Migration',
  'content-migration-backlog': 'Content Migration',
  'cloudfuze-manage-board': 'CF Manage',
};

// ── 3. Expanded summary keyword → productType ─────────────────────────────
function ptFromSummary(summary, dept) {
  if (!summary) return null;
  const s = summary.toLowerCase();

  // Message Migration signals
  if (/\bs2c\b|\bs2t\b|\bt2t\b|\bt2c\b/.test(s)) return 'Message Migration';
  if (/\bslack\b/.test(s)) return 'Message Migration';
  if (/meta.*viva|viva.*engage|workplace.*viva|viva.*workplace/.test(s)) return 'Message Migration';
  if (/\bteams?\b.*migr|migr.*\bteams?\b/.test(s)) return 'Message Migration';
  if (/\bchannel[s]?\b/.test(s)) return 'Message Migration';
  if (/\bdm[s]?\b|\bdirect.?message/.test(s)) return 'Message Migration';
  if (/message.*migr|migr.*message/.test(s)) return 'Message Migration';
  if (/zoom.*migr|migr.*zoom/.test(s)) return 'Message Migration';
  if (/workplace.*migr|migr.*workplace/.test(s)) return 'Message Migration';
  if (/yammer|viva.?engage/.test(s)) return 'Message Migration';

  // Email Migration signals
  if (/\bgmail\b|\bgsuite\b/.test(s)) return 'Email Migration';
  if (/\bexchange\b/.test(s)) return 'Email Migration';
  if (/email.*migr|migr.*email/.test(s)) return 'Email Migration';
  if (/\boutlook\b.*migr|migr.*\boutlook\b/.test(s)) return 'Email Migration';
  if (/\bpst\b/.test(s)) return 'Email Migration';

  // Content Migration signals
  if (/\bbox\b/.test(s)) return 'Content Migration';
  if (/\bdropbox\b/.test(s)) return 'Content Migration';
  if (/\bonedrive\b/.test(s)) return 'Content Migration';
  if (/\bsharepoint\b/.test(s)) return 'Content Migration';
  if (/\bgdrive\b|google.*drive|shared.?drive/.test(s)) return 'Content Migration';
  if (/\bnfs\b|\bsmb\b/.test(s)) return 'Content Migration';
  if (/content.*migr|migr.*content|file.*migr|migr.*file/.test(s)) return 'Content Migration';
  if (/\bfolder[s]?\b|\bfile[s]?\b/.test(s)) return 'Content Migration';
  if (/\bdrive.*change[s]?|\bdrive.*migr/.test(s)) return 'Content Migration';
  // "ws" can be workspace — for content migration context (Box/Drive workspace)
  if (/\bws\b|\bworkspace[s]?\b/.test(s) && !/slack|teams|channel|message/i.test(s)) return 'Content Migration';
  if (/\bhyperlink[s]?\b|\blink[s]?\b.*migr|migr.*\blink[s]?\b/.test(s)) return 'Content Migration';
  if (/\bpermission[s]?\b.*map|map.*\bpermission[s]?\b/.test(s)) return 'Content Migration';
  if (/\bcsv\b.*migr|migr.*\bcsv\b/.test(s)) return 'Content Migration';
  if (/\bretry.*folder|\bfolder.*retry/.test(s)) return 'Content Migration';
  if (/\bsanity.*test|\bvalidat/.test(s) && dept === 'Migration') return 'Content Migration';

  // CF Manage
  if (/cf.?manage|cfmanage/.test(s)) return 'CF Manage';

  // Dept-specific fallbacks for clear migration summaries
  if (dept === 'Migration' || dept === 'migration') {
    // Most migration tickets are content unless flagged above
    if (/\bmigr|\bserver|\bdeploy|\bredeploy|\bretry|\bstuck|\bconflict|\bresume|\bdecommission/.test(s)) {
      return 'Content Migration';
    }
  }

  return null;
}

// ── 4. Determine fills ────────────────────────────────────────────────────
let updates = [];
for (const t of missing) {
  let pt = null;
  const dept = (t.current_department || '').toLowerCase();
  const deptKey = Object.keys(DEPT_PT).find(k => dept === k);

  // 1. Department-deterministic mapping
  if (!pt && deptKey) pt = DEPT_PT[deptKey];

  // 2. Extract customer from summary and cross-match
  if (!pt) {
    const sumCust = extractCustFromSummary(t.summary);
    if (sumCust && sumCust.length > 2 && custPT.has(sumCust)) {
      pt = mostCommon(custPT.get(sumCust));
    }
  }

  // 3. customerName field cross-match
  if (!pt) {
    const cust = (t.customerName || '').trim().toLowerCase();
    if (cust && cust !== 'null' && custPT.has(cust)) pt = mostCommon(custPT.get(cust));
  }

  // 4. Expanded summary keywords
  if (!pt) pt = ptFromSummary(t.summary, t.current_department);

  if (pt) updates.push({ id: t.id, key: t.key, pt, dept: t.current_department, summary: (t.summary || '').slice(0, 60) });
}

console.log(`Would update: ${updates.length} tickets\n`);

const byPT = {};
for (const u of updates) byPT[u.pt] = (byPT[u.pt] || 0) + 1;
Object.entries(byPT).sort((a,b) => b[1]-a[1]).forEach(([pt, cnt]) => console.log(`  ${pt}: ${cnt}`));

const byDept = {};
for (const u of updates) byDept[u.dept || '(none)'] = (byDept[u.dept || '(none)'] || 0) + 1;
console.log('\nBy dept:');
Object.entries(byDept).sort((a,b) => b[1]-a[1]).forEach(([d, cnt]) => console.log(`  ${d}: ${cnt}`));

console.log('\nSample:');
updates.slice(0, 20).forEach(u => console.log(`  ${u.key} [${u.dept}] → "${u.pt}" | ${u.summary}`));

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
