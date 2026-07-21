/**
 * Creates the 297 new CFITS tickets that aren't yet in L1BOAR DB.
 * The 2243 existing-ticket updates already ran in sync-cfits-full.mjs.
 */
import pg from 'pg';
import { randomBytes } from 'crypto';
function genId() {
  return randomBytes(6).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 9).toLowerCase();
}
const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) console.log('DRY RUN — pass --apply to write\n');

const JIRA_EMAIL = 'sujana.manapuram@cloudfuze.com';
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const BASE = 'https://cf2020.atlassian.net';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

const FIELDS = ['summary','status','assignee','reporter','priority','created','updated',
  'customfield_11380','customfield_10236','customfield_10203','customfield_10401','customfield_10883'];

async function jiraPost(body, retries = 8) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 40000);
      const res = await fetch(BASE + '/rest/api/3/search/jql', {
        method: 'POST',
        headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
        signal: ctrl.signal, body: JSON.stringify(body)
      });
      clearTimeout(t);
      return await res.json();
    } catch(e) {
      if (attempt === retries) throw e;
      const delay = Math.min(5000 * attempt, 30000);
      process.stdout.write(` [retry ${attempt}, ${delay/1000}s]`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function extractVal(f) {
  if (f == null) return null;
  if (typeof f === 'string') return f;
  if (Array.isArray(f)) return f.map(extractVal).filter(Boolean).join(', ') || null;
  if (f.value) return f.value;
  if (f.name) return f.name;
  if (f.displayName) return f.displayName;
  return null;
}

// Load existing DB keys/summaries
const existingSummaries = new Set((await pool.query(`SELECT LOWER(TRIM(summary)) s FROM issues WHERE current_department='Migration'`)).rows.map(r => r.s).filter(Boolean));
const existingCfKeys = new Set((await pool.query(`SELECT cf_key FROM issues WHERE cf_key IS NOT NULL`)).rows.map(r => r.cf_key));
const spaceId = (await pool.query(`SELECT "spaceId" FROM issues WHERE key LIKE 'L1BOAR-%' AND "spaceId" IS NOT NULL LIMIT 1`)).rows[0]?.spaceId || 'pg_92q07qtnlz';
console.log(`spaceId=${spaceId}, existing summaries=${existingSummaries.size}`);

// Fetch all CFITS from Jira
console.log('\nFetching CFITS from Jira...');
let allCfits = [], nextPageToken = null, page = 1;
do {
  process.stdout.write(`  Page ${page}...`);
  const body = { jql: 'project = CFITS ORDER BY created ASC', fields: FIELDS, maxResults: 100 };
  if (nextPageToken) body.nextPageToken = nextPageToken;
  const r = await jiraPost(body);
  const issues = r.issues || [];
  allCfits.push(...issues);
  nextPageToken = r.nextPageToken || null;
  process.stdout.write(` ${issues.length} (total: ${allCfits.length})\n`);
  page++;
  if (issues.length === 0) break;
  await new Promise(r => setTimeout(r, 200));
} while (nextPageToken);

// Find new ones
const toCreate = allCfits.filter(i => {
  const s = (i.fields.summary || '').toLowerCase().trim();
  return !existingCfKeys.has(i.key) && !existingSummaries.has(s);
});
console.log(`\nNew tickets to create: ${toCreate.length}`);
toCreate.slice(0, 10).forEach(u => {
  const f = u.fields;
  console.log(`  ${u.key}: "${(f.summary||'').slice(0,55)}" status="${f.status?.name}"`);
});

if (!DRY_RUN && toCreate.length > 0) {
  const maxL1 = (await pool.query(`SELECT MAX(CAST(SPLIT_PART(key,'-',2) AS INTEGER)) m FROM issues WHERE key LIKE 'L1BOAR-%'`)).rows[0].m || 7616;
  let nextNum = maxL1 + 1, imported = 0;
  console.log(`\nInserting from L1BOAR-${nextNum}...`);
  for (const issue of toCreate) {
    const f = issue.fields;
    const newKey = `L1BOAR-${nextNum++}`;
    const priority = (f.priority?.name || 'medium').toLowerCase();
    const jiraStatus = (f.status?.name || '').toLowerCase();
    let statusId = 'status_open';
    if (jiraStatus.includes('done') || jiraStatus.includes('resolved') || jiraStatus.includes('closed')) statusId = 'status_resolved';
    else if (jiraStatus.includes('progress')) statusId = 'status_qa_inprogress';
    const pm    = extractVal(f.customfield_11380);
    const combo = extractVal(f.customfield_10236);
    const pt    = extractVal(f.customfield_10203);
    const cust  = extractVal(f.customfield_10401) || extractVal(f.customfield_10883);
    try {
      await pool.query(`
        INSERT INTO issues (id, key, cf_key, summary, "statusId", priority,
          "projectManager", combination, "productType", "customerName",
          current_department, "spaceId", jira_assignee_name, jira_reporter_name, "createdAt", "updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Migration',$11,$12,$13,$14,$15)
        ON CONFLICT (key) DO NOTHING
      `, [genId(), newKey, issue.key, f.summary, statusId, priority, pm, combo, pt, cust, spaceId,
          f.assignee?.displayName || null, f.reporter?.displayName || null,
          f.created ? new Date(f.created) : new Date(), f.updated ? new Date(f.updated) : new Date()]);
      imported++;
      if (imported % 50 === 0) process.stdout.write(`  ${imported}/${toCreate.length}...\n`);
    } catch(e) { console.log(`  Error ${newKey}: ${e.message}`); }
  }
  console.log(`\nCreated ${imported} new tickets.`);

  // Final summary
  const a = (await pool.query(`SELECT COUNT(*) total, COUNT(CASE WHEN "projectManager" IS NULL OR "projectManager"='' THEN 1 END) miss_pm, COUNT(CASE WHEN combination IS NULL OR combination='' THEN 1 END) miss_combo, COUNT(CASE WHEN "productType" IS NULL OR "productType"='' THEN 1 END) miss_pt FROM issues WHERE current_department='Migration'`)).rows[0];
  console.log(`\n=== Migration Queue Final ===`);
  console.log(`Total: ${a.total} | Missing PM: ${a.miss_pm} | Missing combo: ${a.miss_combo} | Missing PT: ${a.miss_pt}`);
} else if (DRY_RUN) {
  console.log('\nRun with --apply to insert.');
}
await pool.end();
