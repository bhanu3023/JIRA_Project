import pg from 'pg';
const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) console.log('DRY RUN — pass --apply to write changes\n');

const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

const all = (await pool.query(`SELECT id, key, cf_key, summary, "productType", combination, "customerName", current_department FROM issues`)).rows;
const missing = all.filter(t => !t.productType || t.productType === 'null' || t.productType === '');
console.log(`Still missing: ${missing.length}\n`);

// ── Customer lookup ───────────────────────────────────────────────────────
function extractCusts(s) {
  if (!s) return [];
  const results = [];
  // "KBC - Decommission" → "kbc"
  // "shared logik7 db creds" → extract server name before " db"
  const m1 = s.match(/^([^|\-]{2,40?})\s*[\-|]/);
  if (m1) results.push(m1[1].trim().toLowerCase());
  const parts = s.split(/\s*\|\s*/);
  if (parts.length > 1) results.push(parts[0].trim().toLowerCase());
  // "shared X db creds" → extract X
  const m2 = s.match(/shared?\s+([a-z0-9_\-]{3,20})\s+db/i);
  if (m2) results.push(m2[1].toLowerCase());
  // "deployment in X" → extract X
  const m3 = s.match(/deployment\s+in\s+([a-z0-9_\-]{3,20})/i);
  if (m3) results.push(m3[1].toLowerCase());
  // "created X account" or "X - Server" at start
  return results.filter(c => c.length > 2 && !/fw:|re:|fwd:/.test(c));
}
const custPT = new Map();
for (const t of all) {
  if (!t.productType || t.productType === 'null') continue;
  const candidates = [(t.customerName||'').trim().toLowerCase(), ...extractCusts(t.summary)];
  for (const cust of candidates) {
    if (!cust || cust === 'null' || cust.length < 2) continue;
    if (!custPT.has(cust)) custPT.set(cust, new Map());
    custPT.get(cust).set(t.productType, (custPT.get(cust).get(t.productType) || 0) + 1);
  }
}
const mostCommon = m => { let b = null, bc = 0; for (const [v, c] of m) if (c > bc) { b = v; bc = c; } return b; };

// ── Exhaustive keyword function ───────────────────────────────────────────
function ptFromKeywords(s, dept) {
  if (!s) return null;
  const t = s.toLowerCase();

  // ── Message Migration ──
  if (/\bs2c\b|\bs2t\b|\bt2t\b|\bt2c\b|\bc2t\b/.test(t)) return 'Message Migration';
  if (/s2cdev/.test(t)) return 'Message Migration';
  if (/\bslack\b/.test(t)) return 'Message Migration';
  if (/meta.*viva|viva.*engage|workplace.*viva|facebook.*workplace|\bworkplace\b.*migr/.test(t)) return 'Message Migration';
  if (/microsoft.*teams|teams.*onboard|teams.*cloud|teams.*migr/.test(t)) return 'Message Migration';
  if (/\bchannel[s]?\b/.test(t)) return 'Message Migration';
  if (/\bdm[s]?\b|\bdirect.?message/.test(t)) return 'Message Migration';
  if (/\bmention[s]?\b/.test(t)) return 'Message Migration';
  if (/team.*renam|renam.*team/.test(t)) return 'Message Migration';
  if (/meeting.*record|meeting.*chat/.test(t)) return 'Message Migration';
  if (/no.?message.*state|delta.*workspace.*conflict.*no.?message/.test(t)) return 'Message Migration';
  if (/conversation.*fetch|fetch.*conversation/.test(t)) return 'Message Migration';
  if (/delta.*message[s]?|message[s]?.*delta|timestamp.*delta.*message/.test(t)) return 'Message Migration';
  if (/\bchat\b.*destination|destination.*\bchat\b/.test(t)) return 'Message Migration';
  if (/chat.*react|react.*migr.*chat/.test(t)) return 'Message Migration';
  if (/\bsticker[s]?\b.*migr|migr.*\bsticker[s]?\b/.test(t)) return 'Message Migration';
  if (/message[s]?.*not.*mov|message[s]?.*pick|pick.*message[s]?|message[s]?.*conflict|message[s]?.*stuck/.test(t)) return 'Message Migration';
  if (/recorded.*video.*not.*migr|video.*clip.*not.*migr/.test(t)) return 'Message Migration';
  if (/group.*mention/.test(t)) return 'Message Migration';
  if (/\byammer\b/.test(t)) return 'Message Migration';

  // ── Email Migration ──
  if (/\bgmail\b|\bgsuite\b/.test(t)) return 'Email Migration';
  if (/\boutlook\b/.test(t)) return 'Email Migration';  // standalone outlook = email
  if (/\bexchange\b/.test(t)) return 'Email Migration';
  if (/\bpst\b/.test(t)) return 'Email Migration';
  if (/email.*migr|migr.*email|email.*conflict|email.*retry|retry.*email|email.*info|email.*count|email.*slow|email.*not.*mov/.test(t)) return 'Email Migration';
  if (/\battachment[s]?.*conflict|\battachment[s]?.*retry|retry.*attachment[s]?|attach.*store|storing.*attach/.test(t)) return 'Email Migration';
  if (/\bcontact[s]?.*conflict|\bcontact[s]?.*retry/.test(t)) return 'Email Migration';
  if (/calendar.*attachment[s]?|calendar.*event[s]?|event.*calendar/.test(t)) return 'Email Migration';
  if (/archive.*email|email.*archive|flag.*email|mailbox.*rule|mailbox.*migr|in.?place.*archive|archive.*migr/.test(t)) return 'Email Migration';
  if (/mail[s]?.*duplicat|duplicat.*mail[s]?/.test(t)) return 'Email Migration';
  if (/mail[s]?.*mismatch|mismatch.*mail[s]?|mails.*count/.test(t)) return 'Email Migration';
  if (/\bmail.*id.*storage|from.*to.*mail.*id/.test(t)) return 'Email Migration';
  if (/group.*creat.*outlook|outlook.*group.*creat/.test(t)) return 'Email Migration';
  if (/birthday.*migr|holiday.*migr|event.*occur/.test(t)) return 'Email Migration';
  if (/\bpicking.*event[s]?|event[s]?.*picking/.test(t)) return 'Email Migration';
  if (/handling.*409.*outlook|rate.*limit.*outlook/.test(t)) return 'Email Migration';
  if (/\bmail.*inbound|inbound.*mail/.test(t)) return 'Email Migration';
  if (/ms.*google.*migr|google.*ms.*migr/.test(t)) return 'Email Migration';

  // ── Content Migration ──
  if (/\bbox\b/.test(t)) return 'Content Migration';
  if (/\bdropbox\b/.test(t)) return 'Content Migration';
  if (/\bonedrive\b|\bone.?drive\b|\b\od\b.*to|\bod.?to.\bod\b/.test(t)) return 'Content Migration';
  if (/\bsharepoint\b/.test(t)) return 'Content Migration';
  if (/\bgdrive\b|google.*drive|shared.?drive|my.?drive|team.*drive/.test(t)) return 'Content Migration';
  if (/\begnyte\b|\bsharefile\b/.test(t)) return 'Content Migration';
  if (/\bnfs\b|\bsmb\b/.test(t)) return 'Content Migration';
  if (/content.*migr|migr.*content|content.*server|content.*prod|cntpoc/.test(t)) return 'Content Migration';
  if (/\bfolder[s]?.*conflict|\bfolder[s]?.*retry|retry.*folder[s]?/.test(t)) return 'Content Migration';
  if (/\bfile[s]?.*conflict|\bfile[s]?.*retry|retry.*file[s]?/.test(t)) return 'Content Migration';
  if (/\bhyperlink[s]?\b/.test(t)) return 'Content Migration';
  if (/link[s]?.*stuck|link[s]?.*not.*mov|cross.*link|embedded.*link|broken.*link/.test(t)) return 'Content Migration';
  if (/\bpermission[s]?.*conflict|permission[s]?.*retry|retry.*permission[s]?|release.*permission[s]?|permission[s]?.*miss|permission.*not.*mov/.test(t)) return 'Content Migration';
  if (/\bcollab[s]?|\bcollaborator[s]?/.test(t)) return 'Content Migration';
  if (/\btrash\b|\bdeleted.?item[s]?\b/.test(t)) return 'Content Migration';
  if (/\bworkspace[s]?\b|\bws\b|\bwsid\b/.test(t) && !/slack|teams|channel|message|s2c/i.test(t)) return 'Content Migration';
  if (/drive.*change[s]?/.test(t)) return 'Content Migration';
  if (/\bspo\b/.test(t)) return 'Content Migration';
  if (/version.*history|version.*timestamp|timestamp.*mismatch|modified.*date.*mismatch/.test(t)) return 'Content Migration';
  if (/version[s]?.*conflict|conflict.*version[s]?/.test(t)) return 'Content Migration';
  if (/inline.*comment|label.*hierarch|label.*level|label.*sub/.test(t)) return 'Content Migration';
  if (/\bcsv.*fail|\bcsv.*valid|valid.*csv|csv.*download/.test(t)) return 'Content Migration';
  if (/layout.*miss|layout.*migr/.test(t)) return 'Content Migration';
  if (/security.*group[s]?.*creat|creat.*security.*group/.test(t)) return 'Content Migration';
  if (/\bpathlink|\bpath.*link\b/.test(t)) return 'Content Migration';
  if (/numbered.*list|bullet[s]?.*format|list.*format/.test(t)) return 'Content Migration'; // rich text formatting
  if (/created.*by.*implement|modified.*by.*implement/.test(t)) return 'Content Migration';
  if (/tenant.*separat|tenant.*tenant|multi.*tenant|o365.*o365|m365.*m365/.test(t)) return 'Content Migration';
  if (/od.*to.*od|od.*od.*permission/.test(t)) return 'Content Migration';
  if (/\bautomapped\b|auto.*mapp/.test(t)) return 'Content Migration';
  if (/cloud.*onboard|onboard.*cloud/.test(t) && !/teams|slack/i.test(t)) return 'Content Migration';
  if (/shared.*link|public.*search|link.*visib/.test(t)) return 'Content Migration';
  if (/deployment.*content|contentdev|contentprod/.test(t)) return 'Content Migration';

  // ── CF Manage ──
  if (/cf.?manage|cfmanage|cloudfuze.*manage/.test(t)) return 'CF Manage';

  // ── Dept-specific fallbacks ──
  if (dept === 'SalesOps') return 'CF Manage';
  if (dept === 'Migration-Customer') return 'Content Migration';

  if (dept === 'Infra') {
    if (/s2cdev|s2c.*deploy/.test(t)) return 'Message Migration';
    if (/email.*deploy|deploy.*email|email.*data|mail.*inbound/.test(t)) return 'Email Migration';
    // Most infra tickets are content migration support
    return 'Content Migration';
  }

  if (dept === 'QA') {
    if (/cloudfuze.*manage|cf.*manage/.test(t)) return 'CF Manage';
    if (/\bmanage\b.*server|\bmanage\b.*sanity/.test(t)) return 'CF Manage';
    if (/google|drive|one.?drive|sharepoint|box|dropbox|od.*to|spo\b/.test(t)) return 'Content Migration';
    if (/slack|channel|teams|message/.test(t)) return 'Message Migration';
    if (/email|gmail|exchange|calendar|mail/.test(t)) return 'Email Migration';
    // QA default = Content Migration (most common)
    return 'Content Migration';
  }

  if (dept === 'Pre-Sales') {
    if (/google|drive|sharepoint|box|tenant|o365|m365|content/.test(t)) return 'Content Migration';
    if (/email|gmail|exchange|mail/.test(t)) return 'Email Migration';
    if (/slack|teams|channel|message/.test(t)) return 'Message Migration';
    // Pre-sales default = Content Migration
    return 'Content Migration';
  }

  if (dept === 'Dev') {
    // Generic dev tickets with no signal
    if (/\bdb\b|\bdatabase\b|\bquery\b|\bscript\b|\bendpoint\b|\bapi\b/.test(t)) return 'Content Migration';
    if (/\bui\b|\bpage\b|\bdashboard\b|\breport\b|\bbutton\b/.test(t)) return 'Content Migration';
    if (/missing.*data|data.*miss/.test(t)) return 'Content Migration';
  }

  return null;
}

// ── Determine fills ─────────────────────────────────────────────────────────
let updates = [];
for (const t of missing) {
  let pt = null;
  const dept = t.current_department || '';

  // 1. Customer cross-match
  if (!pt) {
    for (const cust of [...extractCusts(t.summary), (t.customerName||'').trim().toLowerCase()]) {
      if (cust && cust.length > 2 && cust !== 'null' && custPT.has(cust)) {
        pt = mostCommon(custPT.get(cust));
        break;
      }
    }
  }
  // 2. Keywords + dept fallbacks
  if (!pt) pt = ptFromKeywords(t.summary, dept);

  if (pt) updates.push({ id: t.id, key: t.key, pt, dept, summary: (t.summary || '').slice(0, 70) });
}

console.log(`Would update: ${updates.length} tickets\n`);
const byPT = {};
for (const u of updates) byPT[u.pt] = (byPT[u.pt] || 0) + 1;
Object.entries(byPT).sort((a,b)=>b[1]-a[1]).forEach(([pt,cnt]) => console.log(`  ${pt}: ${cnt}`));
const byDept = {};
for (const u of updates) byDept[u.dept||'(none)'] = (byDept[u.dept||'(none)'] || 0) + 1;
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
