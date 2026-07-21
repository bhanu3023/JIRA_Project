import pg from 'pg';
const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) console.log('DRY RUN — pass --apply to write changes\n');

const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

const all = (await pool.query(`SELECT id, key, cf_key, summary, "productType", combination, "customerName", current_department FROM issues`)).rows;
const missing = all.filter(t => !t.productType || t.productType === 'null' || t.productType === '');
console.log(`Still missing: ${missing.length}\n`);

// ── Build customer name → productType from filled tickets ──────────────────
function extractCustFromSummary(s) {
  if (!s) return null;
  const m = s.match(/^([^|\-]{2,40?})\s*[\-|]/);
  return m ? m[1].trim().toLowerCase() : null;
}
const custPT = new Map();
for (const t of all) {
  if (!t.productType || t.productType === 'null') continue;
  for (const raw of [t.customerName, extractCustFromSummary(t.summary)]) {
    const cust = (raw || '').trim().toLowerCase();
    if (!cust || cust === 'null' || cust.length < 2) continue;
    if (!custPT.has(cust)) custPT.set(cust, new Map());
    const m = custPT.get(cust);
    m.set(t.productType, (m.get(t.productType) || 0) + 1);
  }
}
const mostCommon = m => { let b = null, bc = 0; for (const [v, c] of m) if (c > bc) { b = v; bc = c; } return b; };

// ── Expanded keyword matcher ───────────────────────────────────────────────
function ptFromKeywords(s, dept) {
  if (!s) return null;
  const t = s.toLowerCase();

  // ── Message Migration ──
  if (/\bs2c\b|\bs2t\b|\bt2t\b|\bt2c\b/.test(t)) return 'Message Migration';
  if (/\bslack\b/.test(t)) return 'Message Migration';
  if (/meta.*viva|viva.*engage|workplace.*viva/.test(t)) return 'Message Migration';
  if (/microsoft.*teams|teams.*cloud|teams.*onboard/.test(t)) return 'Message Migration';
  if (/\bchannel[s]?\b/.test(t)) return 'Message Migration';
  if (/\bdm[s]?\b|\bdirect.?message/.test(t)) return 'Message Migration';
  if (/\bmention[s]?\b/.test(t)) return 'Message Migration';       // user mentions = Teams/Slack
  if (/team.*renam|renam.*team|team.*csv/.test(t)) return 'Message Migration';
  if (/group[s]?.*migr|migr.*group[s]?/.test(t)) return 'Message Migration';
  if (/message[s]?.*not.*mov|message[s]?.*picking|picking.*message[s]?|message[s]?.*conflict|message[s]?.*stuck/.test(t)) return 'Message Migration';
  if (/message.*instance|message.*schedule|message.*server/.test(t)) return 'Message Migration';
  if (/\bzoom.*migr|migr.*zoom/.test(t)) return 'Message Migration';
  if (/\byammer\b/.test(t)) return 'Message Migration';

  // ── Email Migration ──
  if (/\bgmail\b|\bgsuite\b/.test(t)) return 'Email Migration';
  if (/\bexchange\b/.test(t)) return 'Email Migration';
  if (/\bpst\b/.test(t)) return 'Email Migration';
  if (/\boutlook\b.*migr|migr.*\boutlook\b/.test(t)) return 'Email Migration';
  if (/email.*migr|migr.*email|email.*conflict|email.*retry|retry.*email|email.*info|email.*count/.test(t)) return 'Email Migration';
  if (/\battachment[s]?.*conflict|\battachment[s]?.*retry|retry.*attachment[s]?/.test(t)) return 'Email Migration';
  if (/\bcontact[s]?.*conflict|\bcontact[s]?.*retry|retry.*contact[s]?/.test(t)) return 'Email Migration';
  if (/bdcenter.*email|email.*deploy/.test(t)) return 'Email Migration';
  if (/\bpst.*migr|\bmail.*migr/.test(t)) return 'Email Migration';

  // ── Content Migration ──
  if (/\bbox\b/.test(t)) return 'Content Migration';
  if (/\bdropbox\b/.test(t)) return 'Content Migration';
  if (/\bonedrive\b|\bone.?drive\b/.test(t)) return 'Content Migration';
  if (/\bsharepoint\b/.test(t)) return 'Content Migration';
  if (/\bgdrive\b|google.*drive|shared.?drive|my.?drive/.test(t)) return 'Content Migration';
  if (/\begnyte\b|\bsharefile\b/.test(t)) return 'Content Migration';
  if (/\bnfs\b|\bsmb\b/.test(t)) return 'Content Migration';
  if (/content.*migr|migr.*content/.test(t)) return 'Content Migration';
  if (/\bfolder[s]?.*conflict|\bfolder[s]?.*retry|retry.*folder[s]?/.test(t)) return 'Content Migration';
  if (/\bfile[s]?.*conflict|\bfile[s]?.*retry|retry.*file[s]?/.test(t)) return 'Content Migration';
  if (/\bhyperlink[s]?\b/.test(t)) return 'Content Migration';
  if (/\blink[s]?.*stuck|link[s]?.*not.*mov/.test(t)) return 'Content Migration';
  if (/\bpermission[s]?.*conflict|permission[s]?.*retry|retry.*permission[s]?|release.*permission[s]?/.test(t)) return 'Content Migration';
  if (/\bcollab[s]?|\bcollaborator[s]?/.test(t)) return 'Content Migration';
  if (/\btrash\b|\bdeleted.?item[s]?\b/.test(t)) return 'Content Migration';
  if (/\bworkspace[s]?\b|\bws\b/.test(t) && !/slack|teams|channel|message|s2c/i.test(t)) return 'Content Migration';
  if (/drive.*change[s]?/.test(t)) return 'Content Migration';
  if (/permission.*map|map.*permission|\bcsv.*permission|\bpermission.*report/.test(t)) return 'Content Migration';
  if (/spo\b|od\b.*migr|migr.*\bod\b/.test(t)) return 'Content Migration'; // SPO=SharePoint Online, OD=OneDrive

  // ── CF Manage ──
  if (/cf.?manage|cfmanage/.test(t)) return 'CF Manage';
  if (/cloudfuze.*manage|manage.*board/.test(t)) return 'CF Manage';

  // ── Dept-specific logic ──
  if (dept === 'SalesOps') return 'CF Manage'; // sales ops = manage product
  if (dept === 'Migration-Customer') return 'Content Migration'; // most common in migration

  // Infra deployment hints
  if (dept === 'Infra') {
    if (/s2cdev|s2c.*dev/.test(t)) return 'Message Migration';
    if (/email.*deploy|deploy.*email/.test(t)) return 'Email Migration';
    if (/daily.*migration.*report|migration.*report/.test(t)) return 'Content Migration'; // most reports are content
    if (/server.*creat|creat.*server|new.*server|server.*setup/.test(t)) return 'Content Migration';
  }

  // QA has many sanity tests — classify by content in summary
  if (dept === 'QA') {
    if (/\bmanage\b/.test(t)) return 'CF Manage';
    if (/sanity|testing|test/.test(t) && /google|drive|one.?drive|sharepoint|box|dropbox/.test(t)) return 'Content Migration';
    if (/sanity|testing|test/.test(t) && /slack|channel|teams|message/.test(t)) return 'Message Migration';
    if (/sanity|testing|test/.test(t) && /email|gmail|exchange/.test(t)) return 'Email Migration';
  }

  return null;
}

// ── Determine fills ─────────────────────────────────────────────────────────
let updates = [];
for (const t of missing) {
  let pt = null;
  const dept = t.current_department || '';

  // 1. Extract customer from summary → cross-match
  if (!pt) {
    const sumCust = extractCustFromSummary(t.summary);
    if (sumCust && sumCust.length > 2 && custPT.has(sumCust)) pt = mostCommon(custPT.get(sumCust));
  }
  // 2. customerName field
  if (!pt) {
    const cust = (t.customerName || '').trim().toLowerCase();
    if (cust && cust !== 'null' && custPT.has(cust)) pt = mostCommon(custPT.get(cust));
  }
  // 3. Keywords
  if (!pt) pt = ptFromKeywords(t.summary, dept);

  if (pt) updates.push({ id: t.id, key: t.key, pt, dept, summary: (t.summary || '').slice(0, 70) });
}

console.log(`Would update: ${updates.length} tickets\n`);
const byPT = {};
for (const u of updates) byPT[u.pt] = (byPT[u.pt] || 0) + 1;
Object.entries(byPT).sort((a,b)=>b[1]-a[1]).forEach(([pt,cnt]) => console.log(`  ${pt}: ${cnt}`));
const byDept = {};
for (const u of updates) byDept[u.dept || '(none)'] = (byDept[u.dept || '(none)'] || 0) + 1;
console.log('\nBy dept:');
Object.entries(byDept).sort((a,b)=>b[1]-a[1]).forEach(([d,cnt]) => console.log(`  ${d}: ${cnt}`));

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
