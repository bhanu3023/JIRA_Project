/**
 * Full CFITS → Migration queue sync:
 * 1. Fetch ALL CFITS tickets from Jira (using nextPageToken pagination)
 * 2. For existing L1BOAR tickets: fill missing PM/combo/PT by summary match
 * 3. For new CFITS tickets: create new L1BOAR entries
 */
import pg from 'pg';
const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) console.log('DRY RUN — pass --apply to write changes\n');

const JIRA_EMAIL = 'sujana.manapuram@cloudfuze.com';
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const BASE = 'https://cf2020.atlassian.net';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

const FIELDS = ['summary','status','assignee','reporter','priority','created','updated',
  'customfield_11380','customfield_10236','customfield_10203',
  'customfield_10401','customfield_10883','customfield_10016','customfield_11404'];

async function jiraPost(body, retries = 8) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 40000);
      const res = await fetch(BASE + '/rest/api/3/search/jql', {
        method: 'POST',
        headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify(body)
      });
      clearTimeout(t);
      return await res.json();
    } catch(e) {
      if (attempt === retries) throw e;
      const delay = Math.min(5000 * attempt, 30000);
      process.stdout.write(` [retry ${attempt}, wait ${delay/1000}s]`);
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

// ── Fetch ALL CFITS tickets from Jira ─────────────────────────────────────
console.log('Fetching all CFITS tickets from Jira...');
let allCfits = [];
let nextPageToken = null;
let page = 1;
do {
  process.stdout.write(`  Page ${page}...`);
  const body = { jql: 'project = CFITS ORDER BY created ASC', fields: FIELDS, maxResults: 100 };
  if (nextPageToken) body.nextPageToken = nextPageToken;
  const r = await jiraPost(body);
  const issues = r.issues || [];
  allCfits.push(...issues);
  nextPageToken = r.nextPageToken || null;
  process.stdout.write(` got ${issues.length} (total: ${allCfits.length})\n`);
  page++;
  if (issues.length === 0) break;
  await new Promise(r => setTimeout(r, 200));
} while (nextPageToken);
console.log(`\nTotal CFITS from Jira: ${allCfits.length}\n`);

// ── Load existing DB data ──────────────────────────────────────────────────
const dbMigration = (await pool.query(`
  SELECT id, key, cf_key, summary,
    "projectManager", combination, "productType", "customerName",
    current_department
  FROM issues WHERE current_department = 'Migration'
`)).rows;

// Build lookup maps
const summaryToDb = new Map(); // normalized summary → db row
for (const r of dbMigration) {
  const s = (r.summary || '').toLowerCase().trim();
  if (s) summaryToDb.set(s, r);
}
const cfKeyToDb = new Map(); // cfits key (CFITS-XXXX) → db row
for (const r of dbMigration) {
  if (r.cf_key) cfKeyToDb.set(r.cf_key, r);
}

console.log(`DB Migration tickets: ${dbMigration.length}`);
console.log(`CFITS tickets in Jira: ${allCfits.length}\n`);

// ── Categorize ────────────────────────────────────────────────────────────
let toFill = [];   // exists in DB, missing PM/combo/PT → can fill from Jira
let toCreate = []; // new in Jira, not in DB

for (const issue of allCfits) {
  const f = issue.fields;
  const jiraPM    = extractVal(f.customfield_11380);
  const jiraCombo = extractVal(f.customfield_10236);
  const jiraPT    = extractVal(f.customfield_10203);
  const jiraCust  = extractVal(f.customfield_10401) || extractVal(f.customfield_10883);
  const summaryKey = (f.summary || '').toLowerCase().trim();

  // Find matching DB row
  const dbRow = cfKeyToDb.get(issue.key) || summaryToDb.get(summaryKey);

  if (dbRow) {
    // Check if any field is missing and Jira has it
    const needsPM    = (!dbRow.projectManager || dbRow.projectManager === 'null') && jiraPM;
    const needsCombo = (!dbRow.combination || dbRow.combination === 'null') && jiraCombo;
    const needsPT    = (!dbRow.productType || dbRow.productType === 'null') && jiraPT;
    const needsCust  = (!dbRow.customerName || dbRow.customerName === 'null') && jiraCust;
    const needsCfKey = !dbRow.cf_key || dbRow.cf_key === 'null';

    if (needsPM || needsCombo || needsPT || needsCust || needsCfKey) {
      toFill.push({ dbRow, issue, jiraPM, jiraCombo, jiraPT, jiraCust, needsPM, needsCombo, needsPT, needsCust, needsCfKey });
    }
  } else {
    toCreate.push({ issue, jiraPM, jiraCombo, jiraPT, jiraCust });
  }
}

console.log(`Existing tickets to update (fill PM/combo/PT): ${toFill.length}`);
console.log(`New tickets to create: ${toCreate.length}`);

// Sample updates
console.log('\nSample fills:');
toFill.slice(0,8).forEach(u => {
  const f = u.issue.fields;
  console.log(`  ${u.dbRow.key} (${u.issue.key}): PM="${u.jiraPM||'-'}" combo="${u.jiraCombo||'-'}" pt="${u.jiraPT||'-'}" | ${(f.summary||'').slice(0,50)}`);
});
console.log('\nSample new tickets:');
toCreate.slice(0,8).forEach(u => {
  const f = u.issue.fields;
  console.log(`  ${u.issue.key}: PM="${u.jiraPM||'-'}" combo="${u.jiraCombo||'-'}" pt="${u.jiraPT||'-'}" | ${(f.summary||'').slice(0,55)}`);
});

if (!DRY_RUN) {
  // ── Fill existing tickets ────────────────────────────────────────────────
  if (toFill.length > 0) {
    console.log(`\nFilling ${toFill.length} existing tickets...`);
    let done = 0;
    for (const u of toFill) {
      const sets = [], vals = [];
      if (u.needsPM)    { sets.push(`"projectManager" = $${sets.length+1}`); vals.push(u.jiraPM); }
      if (u.needsCombo) { sets.push(`combination = $${sets.length+1}`);       vals.push(u.jiraCombo); }
      if (u.needsPT)    { sets.push(`"productType" = $${sets.length+1}`);     vals.push(u.jiraPT); }
      if (u.needsCust)  { sets.push(`"customerName" = $${sets.length+1}`);    vals.push(u.jiraCust); }
      if (u.needsCfKey) { sets.push(`cf_key = $${sets.length+1}`);            vals.push(u.issue.key); }
      vals.push(u.dbRow.id);
      if (sets.length > 0) {
        await pool.query(`UPDATE issues SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
        done++;
      }
      if (done % 200 === 0) process.stdout.write(`  ${done}/${toFill.length}...\n`);
    }
    console.log(`Filled ${done} tickets.`);
  }

  // ── Create new tickets ───────────────────────────────────────────────────
  if (toCreate.length > 0) {
    const maxL1 = (await pool.query(`SELECT MAX(CAST(SPLIT_PART(key,'-',2) AS INTEGER)) m FROM issues WHERE key LIKE 'L1BOAR-%'`)).rows[0].m || 7616;
    // Get spaceId from existing L1BOAR tickets
    const spaceIdRow = (await pool.query(`SELECT "spaceId" FROM issues WHERE key LIKE 'L1BOAR-%' AND "spaceId" IS NOT NULL LIMIT 1`)).rows[0];
    const spaceId = spaceIdRow?.spaceId || 'pg_92q07qtnlz';
    let nextNum = maxL1 + 1;
    let imported = 0;

    console.log(`\nCreating ${toCreate.length} new L1BOAR tickets (from L1BOAR-${nextNum}, spaceId=${spaceId})...`);
    for (const u of toCreate) {
      const f = u.issue.fields;
      const newKey = `L1BOAR-${nextNum++}`;
      const priority = (f.priority?.name || 'medium').toLowerCase();
      // Map Jira status name to DB statusId
      const jiraStatus = (f.status?.name || '').toLowerCase();
      let statusId = null;
      if (jiraStatus.includes('done') || jiraStatus.includes('resolved') || jiraStatus.includes('closed')) {
        statusId = 'status_resolved';
      } else if (jiraStatus.includes('progress')) {
        statusId = 'status_qa_inprogress';
      } else {
        statusId = 'status_open';
      }
      try {
        await pool.query(`
          INSERT INTO issues (
            key, cf_key, summary, "statusId", priority,
            "projectManager", combination, "productType", "customerName",
            current_department, "spaceId", jira_assignee_name, jira_reporter_name,
            "createdAt", "updatedAt"
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Migration',$10,$11,$12,$13,$14)
          ON CONFLICT (key) DO NOTHING
        `, [newKey, u.issue.key, f.summary, statusId, priority,
            u.jiraPM, u.jiraCombo, u.jiraPT, u.jiraCust,
            spaceId, f.assignee?.displayName || null, f.reporter?.displayName || null,
            f.created ? new Date(f.created) : new Date(),
            f.updated ? new Date(f.updated) : new Date()]);
        imported++;
        if (imported % 50 === 0) process.stdout.write(`  ${imported}/${toCreate.length}...\n`);
      } catch(e) {
        console.log(`  Error ${newKey}: ${e.message}`);
      }
    }
    console.log(`Created ${imported} new tickets.`);
  }

  // ── Final summary ────────────────────────────────────────────────────────
  const after = await pool.query(`
    SELECT
      COUNT(*) total,
      COUNT(CASE WHEN "projectManager" IS NULL OR "projectManager"='' OR "projectManager"='null' THEN 1 END) miss_pm,
      COUNT(CASE WHEN combination IS NULL OR combination='' OR combination='null' THEN 1 END) miss_combo,
      COUNT(CASE WHEN "productType" IS NULL OR "productType"='' OR "productType"='null' THEN 1 END) miss_pt
    FROM issues WHERE current_department = 'Migration'
  `);
  const a = after.rows[0];
  console.log(`\n=== Final Migration Queue ===`);
  console.log(`Total: ${a.total} | Missing PM: ${a.miss_pm} | Missing combo: ${a.miss_combo} | Missing PT: ${a.miss_pt}`);
} else {
  console.log('\nRun with --apply to write changes.');
}

await pool.end();
