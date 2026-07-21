import pg from 'pg';
const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) console.log('DRY RUN — pass --apply to write changes\n');

const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

const all = (await pool.query(`SELECT id, key, cf_key, summary, "productType", combination, "customerName", current_department FROM issues`)).rows;
const missing = all.filter(t => !t.productType || t.productType === 'null' || t.productType === '');
console.log(`Still missing: ${missing.length}\n`);

// ── Customer lookup from all filled tickets ───────────────────────────────
function extractCusts(s) {
  if (!s) return [];
  const results = [];
  // "Este - Validation" → "este"
  const m1 = s.match(/^([^|\-]{2,40?})\s*[\-|]/);
  if (m1) results.push(m1[1].trim().toLowerCase());
  // Also try splitting by " | "
  const parts = s.split(/\s*\|\s*/);
  if (parts.length > 1) results.push(parts[0].trim().toLowerCase());
  return results.filter(c => c.length > 2);
}
const custPT = new Map();
for (const t of all) {
  if (!t.productType || t.productType === 'null') continue;
  const candidates = [
    (t.customerName || '').trim().toLowerCase(),
    ...extractCusts(t.summary)
  ];
  for (const cust of candidates) {
    if (!cust || cust === 'null' || cust.length < 2) continue;
    if (!custPT.has(cust)) custPT.set(cust, new Map());
    const m = custPT.get(cust);
    m.set(t.productType, (m.get(t.productType) || 0) + 1);
  }
}
const mostCommon = m => { let b = null, bc = 0; for (const [v, c] of m) if (c > bc) { b = v; bc = c; } return b; };

// ── Expanded keyword function ──────────────────────────────────────────────
function ptFromKeywords(s, dept) {
  if (!s) return null;
  const t = s.toLowerCase();

  // ── Message Migration ──
  if (/\bs2c\b|\bs2t\b|\bt2t\b|\bt2c\b|\bc2t\b/.test(t)) return 'Message Migration';
  if (/s2cdev|s2c.*server|s2c.*code|s2c.*job|s2c.*deploy/.test(t)) return 'Message Migration';
  if (/\bslack\b/.test(t)) return 'Message Migration';
  if (/meta.*viva|viva.*engage|workplace.*viva|facebook.*workplace|\bworkplace\b/.test(t)) return 'Message Migration';
  if (/microsoft.*teams|teams.*onboard|teams.*cloud|teams.*migr/.test(t)) return 'Message Migration';
  if (/\bchannel[s]?\b/.test(t)) return 'Message Migration';
  if (/\bdm[s]?\b|\bdirect.?message/.test(t)) return 'Message Migration';
  if (/\bmention[s]?\b/.test(t)) return 'Message Migration';
  if (/team.*renam|renam.*team|team.*csv/.test(t)) return 'Message Migration';
  if (/meeting.*record|meeting.*chat|meeting.*migr/.test(t)) return 'Message Migration';
  if (/message[s]?.*not.*mov|message[s]?.*pick|pick.*message[s]?|message[s]?.*conflict|message[s]?.*stuck|message[s]?.*miss/.test(t)) return 'Message Migration';
  if (/message.*instance|message.*schedule|message.*server/.test(t)) return 'Message Migration';
  if (/message.*read.*status|read.*status.*message/.test(t)) return 'Message Migration';
  if (/meta.*chat|chat.*meta|meta.*group|group.*meta/.test(t)) return 'Message Migration';
  if (/\byammer\b|\bzoom\b/.test(t) && /migr/.test(t)) return 'Message Migration';
  if (/user.*group[s]?.*not.*migr|group.*mention/.test(t)) return 'Message Migration';

  // ── Email Migration ──
  if (/\bgmail\b|\bgsuite\b/.test(t)) return 'Email Migration';
  if (/\bexchange\b/.test(t)) return 'Email Migration';
  if (/\bpst\b/.test(t)) return 'Email Migration';
  if (/\boutlook\b.*migr|migr.*\boutlook\b/.test(t)) return 'Email Migration';
  if (/email.*migr|migr.*email|email.*conflict|email.*retry|retry.*email|email.*info|email.*count|email.*slow|email.*not.*mov/.test(t)) return 'Email Migration';
  if (/\battachment[s]?.*conflict|\battachment[s]?.*retry|retry.*attachment[s]?|attachment[s]?.*miss/.test(t)) return 'Email Migration';
  if (/\bcontact[s]?.*conflict|\bcontact[s]?.*retry|retry.*contact[s]?/.test(t)) return 'Email Migration';
  if (/\bcalendar.*event|event.*calendar|calendar.*miss/.test(t)) return 'Email Migration';
  if (/archive.*email|email.*archive|flag.*email|mailbox.*rule|mailbox.*migr|in.?place.*archive/.test(t)) return 'Email Migration';
  if (/bdcenter.*email|email.*deploy/.test(t)) return 'Email Migration';
  if (/\bpst.*migr|\bmail.*migr/.test(t)) return 'Email Migration';
  if (/subject.*line|event.*subject/.test(t)) return 'Email Migration'; // email subject lines

  // ── Content Migration ──
  if (/\bbox\b/.test(t)) return 'Content Migration';
  if (/\bdropbox\b/.test(t)) return 'Content Migration';
  if (/\bonedrive\b|\bone.?drive\b/.test(t)) return 'Content Migration';
  if (/\bsharepoint\b/.test(t)) return 'Content Migration';
  if (/\bgdrive\b|google.*drive|shared.?drive|my.?drive/.test(t)) return 'Content Migration';
  if (/\begnyte\b|\bsharefile\b/.test(t)) return 'Content Migration';
  if (/\bnfs\b|\bsmb\b/.test(t)) return 'Content Migration';
  if (/content.*migr|migr.*content|content.*server|sanity.*content/.test(t)) return 'Content Migration';
  if (/\bfolder[s]?.*conflict|\bfolder[s]?.*retry|retry.*folder[s]?/.test(t)) return 'Content Migration';
  if (/\bfile[s]?.*conflict|\bfile[s]?.*retry|retry.*file[s]?/.test(t)) return 'Content Migration';
  if (/\bhyperlink[s]?\b/.test(t)) return 'Content Migration';
  if (/link[s]?.*stuck|link[s]?.*not.*mov|cross.*link|embedded.*link/.test(t)) return 'Content Migration';
  if (/\bpermission[s]?.*conflict|permission[s]?.*retry|retry.*permission[s]?|release.*permission[s]?|permission[s]?.*miss|permission.*not.*mov/.test(t)) return 'Content Migration';
  if (/\bcollab[s]?|\bcollaborator[s]?/.test(t)) return 'Content Migration';
  if (/\btrash\b|\bdeleted.?item[s]?\b/.test(t)) return 'Content Migration';
  if (/\bworkspace[s]?\b|\bws\b/.test(t) && !/slack|teams|channel|message|s2c/i.test(t)) return 'Content Migration';
  if (/drive.*change[s]?/.test(t)) return 'Content Migration';
  if (/permission.*map|map.*permission|\bcsv.*permission|\bpermission.*report/.test(t)) return 'Content Migration';
  if (/\bspo\b|\bod\b.*migr/.test(t)) return 'Content Migration';
  if (/version.*history|version.*timestamp|timestamp.*mismatch|modified.*date.*mismatch/.test(t)) return 'Content Migration';
  if (/inline.*comment|layout.*miss|layout.*migr/.test(t)) return 'Content Migration';
  if (/\bcsv.*fail|\bcsv.*valid|valid.*csv/.test(t)) return 'Content Migration';
  if (/shared.*link|public.*search/.test(t)) return 'Content Migration';
  if (/\bwsid\b/.test(t)) return 'Content Migration'; // workspace ID
  if (/security.*group[s]?.*requir/.test(t)) return 'Content Migration'; // permissions
  if (/deployment.*content|contentdev/.test(t)) return 'Content Migration';

  // ── Pre-Sales tenant-to-tenant = Content Migration mostly ──
  if (dept === 'Pre-Sales') {
    if (/tenant.*tenant|multi.*tenant|o365.*o365|m365.*m365|ms365.*tenant|tenant.*ms365/.test(t)) return 'Content Migration';
    if (/google.*ms.*migr|google.*microsoft.*migr|google.*365/.test(t)) return 'Content Migration';
    if (/sharefile.*spo|spo.*sharefile/.test(t)) return 'Content Migration';
    if (/google.*google.*demo|google.*tenant|g.*to.*g/.test(t)) return 'Content Migration';
    if (/google.*ms|google.*microsoft/.test(t)) return 'Content Migration';
    if (/ms.*to.*ms|office.*365|o365|m365/.test(t)) return 'Content Migration';
    if (/demo|poc|pilot|kickoff|kick.off/.test(t)) return 'Content Migration'; // default for pre-sales demos
  }

  // ── CF Manage ──
  if (/cf.?manage|cfmanage|cloudfuze.*manage/.test(t)) return 'CF Manage';

  // ── Dept fallbacks for completely ambiguous ops tickets ──
  if (dept === 'SalesOps') return 'CF Manage';
  if (dept === 'Migration-Customer') return 'Content Migration';

  if (dept === 'Infra') {
    if (/s2cdev|s2c.*deploy/.test(t)) return 'Message Migration';
    if (/email.*deploy|deploy.*email|email.*data.*collect/.test(t)) return 'Email Migration';
    if (/deploy.*content|contentdev/.test(t)) return 'Content Migration';
    if (/daily.*migr.*report|migr.*report/.test(t)) return 'Content Migration';
    if (/server.*creat|creat.*server|new.*server|alloc.*server|server.*setup/.test(t)) return 'Content Migration';
    if (/tomcat|deploy|restart.*job|job.*restart/.test(t)) return 'Content Migration'; // infra ops default
  }

  if (dept === 'QA') {
    if (/cloudfuze.*manage|cf.*manage/.test(t)) return 'CF Manage';
    if (/\bcontent\b/.test(t)) return 'Content Migration';
    if (/google|drive|one.?drive|sharepoint|box|dropbox/.test(t)) return 'Content Migration';
    if (/slack|channel|teams|message/.test(t)) return 'Message Migration';
    if (/email|gmail|exchange/.test(t)) return 'Email Migration';
    if (/sanity|test/.test(t)) return 'Content Migration'; // most QA sanity = content
  }

  if (dept === 'Migration') {
    if (/email.*slow|email.*not.*mov/.test(t)) return 'Email Migration';
    if (/\btomcat[s]?\b|\bpriority.*tomcat/.test(t)) return 'Content Migration'; // server ops for migration
    if (/sanity|testing/.test(t)) return 'Content Migration';
    if (/permission|version|user.*map|user.*not.*pop/.test(t)) return 'Content Migration';
    return 'Content Migration'; // migration dept fallback (most common)
  }

  return null;
}

// ── Determine fills ─────────────────────────────────────────────────────────
let updates = [];
for (const t of missing) {
  let pt = null;
  const dept = t.current_department || '';

  // 1. Customer cross-match (from summary + customerName)
  if (!pt) {
    for (const cust of [...extractCusts(t.summary), (t.customerName||'').trim().toLowerCase()]) {
      if (cust && cust.length > 2 && cust !== 'null' && custPT.has(cust)) {
        pt = mostCommon(custPT.get(cust));
        break;
      }
    }
  }
  // 2. Keywords
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
