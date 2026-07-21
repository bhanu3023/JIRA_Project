/**
 * Imports new CFITS (L1BOAR) tickets from Jira that don't exist in DB.
 * Match strategy: exact summary match to detect duplicates.
 */
import pg from 'pg';
const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) console.log('DRY RUN — pass --apply to write changes\n');

const JIRA_EMAIL = 'sujana.manapuram@cloudfuze.com';
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const BASE = 'https://cf2020.atlassian.net';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

async function jira(path, body = null, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(BASE + path, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
        signal: controller.signal,
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      clearTimeout(timer);
      return { status: res.status, data: await res.json() };
    } catch (e) {
      if (attempt === retries) throw e;
      process.stdout.write(` [retry ${attempt}]`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

function extractVal(f) {
  if (!f) return null;
  if (typeof f === 'string') return f;
  if (f.value) return f.value;
  if (f.name) return f.name;
  if (f.displayName) return f.displayName;
  if (Array.isArray(f)) return f.map(extractVal).filter(Boolean).join(', ');
  return null;
}

// Get latest L1BOAR date in DB
const latestDate = (await pool.query(`SELECT MAX("createdAt") m FROM issues WHERE current_department = 'Migration' AND key LIKE 'L1BOAR-%'`)).rows[0].m;
console.log(`Latest L1BOAR in DB created: ${latestDate}`);

// Build summary → exists map from DB
const existingSummaries = new Set();
const allL1 = (await pool.query(`SELECT LOWER(TRIM(summary)) s FROM issues WHERE current_department = 'Migration'`)).rows;
for (const r of allL1) if (r.s) existingSummaries.add(r.s);
console.log(`Existing Migration summaries in DB: ${existingSummaries.size}`);

// Also build a cf_key set
const existingCfKeys = new Set((await pool.query(`SELECT cf_key FROM issues WHERE cf_key IS NOT NULL`)).rows.map(r => r.cf_key));

// Fetch all CFITS tickets from Jira (paginate)
console.log('\nFetching CFITS tickets from Jira...');
let allCfits = [];
let startAt = 0;
const PAGE = 100;
while (true) {
  process.stdout.write(`  page startAt=${startAt}...`);
  const r = await jira('/rest/api/3/search/jql', {
    jql: 'project = CFITS ORDER BY created ASC',
    fields: ['summary', 'status', 'assignee', 'reporter', 'priority', 'created', 'updated',
             'customfield_11380', 'customfield_10236', 'customfield_10203',
             'customfield_10401', 'customfield_10883', 'customfield_10016', 'customfield_11404'],
    maxResults: PAGE,
    startAt
  });
  const issues = r.data.issues || [];
  allCfits.push(...issues);
  process.stdout.write(` got ${issues.length} (total so far: ${allCfits.length})\n`);
  if (issues.length < PAGE) break;
  startAt += PAGE;
  await new Promise(r => setTimeout(r, 150));
}
console.log(`\nTotal CFITS from Jira: ${allCfits.length}`);

// Find which ones aren't in DB
const toImport = allCfits.filter(issue => {
  const summary = (issue.fields.summary || '').toLowerCase().trim();
  const cfKey = issue.key; // CFITS-XXXX
  // Not in DB by cf_key or summary
  return !existingCfKeys.has(cfKey) && !existingSummaries.has(summary);
});

console.log(`\nNew tickets to import: ${toImport.length}`);
console.log('Sample:');
toImport.slice(0, 15).forEach(i => {
  const f = i.fields;
  const pm = extractVal(f.customfield_11380) || '-';
  const combo = extractVal(f.customfield_10236) || '-';
  const pt = extractVal(f.customfield_10203) || '-';
  console.log(`  ${i.key}: PM="${pm}" combo="${combo}" pt="${pt}" | ${(f.summary||'').slice(0,55)}`);
});

// Also show how many existing tickets match CFITS keys (to update cf_key)
const cfitsKeysInDb = allCfits.filter(i => existingCfKeys.has(i.key)).length;
console.log(`\nCFITS tickets already in DB (by CFITS key): ${cfitsKeysInDb}`);
const cfitsSummaryMatch = allCfits.filter(i => existingSummaries.has((i.fields.summary||'').toLowerCase().trim())).length;
console.log(`CFITS tickets matched by summary: ${cfitsSummaryMatch}`);
console.log(`CFITS tickets not matched (truly new): ${toImport.length}`);

if (!DRY_RUN && toImport.length > 0) {
  // Get next L1BOAR number
  const maxL1 = (await pool.query(`SELECT MAX(CAST(SPLIT_PART(key,'-',2) AS INTEGER)) m FROM issues WHERE key LIKE 'L1BOAR-%'`)).rows[0].m || 7616;
  const spaceId = (await pool.query(`SELECT id FROM spaces WHERE key = 'L1BOAR' LIMIT 1`)).rows[0]?.id;
  let nextNum = maxL1 + 1;
  let imported = 0;

  console.log(`\nImporting ${toImport.length} tickets (starting at L1BOAR-${nextNum})...`);
  for (const issue of toImport) {
    const f = issue.fields;
    const newKey = `L1BOAR-${nextNum++}`;
    const pm = extractVal(f.customfield_11380);
    const combo = extractVal(f.customfield_10236);
    const pt = extractVal(f.customfield_10203);
    const cust = extractVal(f.customfield_10401) || extractVal(f.customfield_10883);
    const status = f.status?.name || 'To Do';
    const priority = f.priority?.name || 'Medium';
    const summary = f.summary || '';
    const assigneeName = f.assignee?.displayName || null;
    const reporterName = f.reporter?.displayName || null;
    const createdAt = f.created ? new Date(f.created) : new Date();
    const updatedAt = f.updated ? new Date(f.updated) : new Date();

    try {
      await pool.query(`
        INSERT INTO issues (
          key, cf_key, summary, status, priority,
          "projectManager", combination, "productType", "customerName",
          current_department, "spaceId",
          jira_assignee_name, jira_reporter_name,
          "createdAt", "updatedAt"
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Migration',$10,$11,$12,$13,$14)
        ON CONFLICT (key) DO NOTHING
      `, [newKey, issue.key, summary, status, priority, pm, combo, pt, cust,
          spaceId, assigneeName, reporterName, createdAt, updatedAt]);
      imported++;
      if (imported % 50 === 0) process.stdout.write(`  ${imported}/${toImport.length}...\n`);
    } catch(e) {
      console.log(`  Error inserting ${newKey}: ${e.message}`);
    }
  }
  console.log(`\nImported ${imported} new L1BOAR tickets.`);

  // Final stats
  const after = await pool.query(`SELECT COUNT(*) c FROM issues WHERE current_department = 'Migration'`);
  console.log(`Migration queue now has: ${after.rows[0].c} tickets`);
} else if (DRY_RUN) {
  console.log('\nRun with --apply to write changes.');
}

await pool.end();
