/**
 * Syncs CFITSA (Jira CFITS project) → Migration queue (L1BOAR space)
 * 1. Fills missing PM + combo for existing L1BOAR tickets via their cf_key
 * 2. Imports new CFITS tickets that don't exist yet in DB
 */
import pg from 'pg';
import https from 'https';

const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) console.log('DRY RUN — pass --apply to write changes\n');

const JIRA_BASE = 'cf2020.atlassian.net';
const JIRA_EMAIL = 'sujana.manapuram@cloudfuze.com';
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const FIELDS = 'summary,status,assignee,reporter,customfield_11380,customfield_10236,customfield_10203,customfield_10401,customfield_10883,customfield_11404,customfield_10016,created,updated,description,priority,issuetype,labels,components';

const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

function jiraGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: JIRA_BASE, path, headers: { Authorization: AUTH, Accept: 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function jiraPost(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: JIRA_BASE, path: '/rest/api/3/search/jql', method: 'POST',
      headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
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

// ── Step 1: Fill missing PM/combo for existing tickets via cf_key ──────────
console.log('=== Step 1: Fill missing PM/combo from Jira ===\n');

const missingRows = (await pool.query(`
  SELECT id, key, cf_key FROM issues
  WHERE current_department = 'Migration'
    AND cf_key IS NOT NULL AND cf_key != '' AND cf_key != 'null'
    AND cf_key LIKE 'CF-%'
    AND (
      "projectManager" IS NULL OR "projectManager" = '' OR "projectManager" = 'null' OR
      combination IS NULL OR combination = '' OR combination = 'null'
    )
`)).rows;

console.log(`Tickets needing PM/combo from Jira: ${missingRows.length}`);

// Batch fetch from Jira in groups of 100
const BATCH = 100;
let fills = [];
for (let i = 0; i < missingRows.length; i += BATCH) {
  const batch = missingRows.slice(i, i + BATCH);
  const keys = batch.map(r => r.cf_key).join(',');
  process.stdout.write(`  Fetching batch ${Math.floor(i/BATCH)+1}/${Math.ceil(missingRows.length/BATCH)}...`);
  try {
    const result = await jiraPost({
      jql: `key in (${keys})`,
      fields: FIELDS.split(','),
      maxResults: BATCH
    });
    if (result.issues) {
      for (const issue of result.issues) {
        const f = issue.fields;
        const pm = extractVal(f.customfield_11380);
        const combo = extractVal(f.customfield_10236);
        const pt = extractVal(f.customfield_10203);
        const cust = extractVal(f.customfield_10401) || extractVal(f.customfield_10883);
        const dbRow = batch.find(r => r.cf_key === issue.key);
        if (dbRow && (pm || combo)) {
          fills.push({ id: dbRow.id, key: dbRow.key, cfKey: issue.key, pm, combo, pt, cust });
        }
      }
    }
    process.stdout.write(` got ${result.issues?.length || 0}\n`);
  } catch(e) {
    process.stdout.write(` ERROR: ${e.message}\n`);
  }
  await new Promise(r => setTimeout(r, 200));
}

console.log(`\nCan fill: ${fills.length} tickets (PM: ${fills.filter(f=>f.pm).length}, combo: ${fills.filter(f=>f.combo).length})`);
console.log('\nSample fills:');
fills.slice(0,10).forEach(f => console.log(`  ${f.key} (${f.cfKey}) → PM="${f.pm||'-'}" combo="${f.combo||'-'}"`));

// ── Step 2: Find new CFITS tickets not yet in DB ───────────────────────────
console.log('\n=== Step 2: Sync new CFITS tickets ===\n');

const maxCFNum = (await pool.query(`
  SELECT MAX(CAST(SPLIT_PART(cf_key, '-', 2) AS INTEGER)) max_num
  FROM issues WHERE cf_key LIKE 'CF-%' AND current_department = 'Migration'
`)).rows[0].max_num || 0;
console.log(`Max CF key in DB: CF-${maxCFNum}`);

// Fetch all CFITS tickets newer than what we have
let newTickets = [];
let startAt = 0;
const pageSize = 100;
while (true) {
  process.stdout.write(`  Fetching CFITS tickets startAt=${startAt}...`);
  const result = await jiraPost({
    jql: `project = CFITS AND key > CF-${maxCFNum} ORDER BY key ASC`,
    fields: FIELDS.split(','),
    maxResults: pageSize,
    startAt
  });
  if (!result.issues || result.issues.length === 0) { process.stdout.write(' done\n'); break; }
  newTickets.push(...result.issues);
  process.stdout.write(` got ${result.issues.length} (total: ${newTickets.length})\n`);
  if (result.issues.length < pageSize) break;
  startAt += pageSize;
  await new Promise(r => setTimeout(r, 300));
}
console.log(`\nNew tickets to import: ${newTickets.length}`);
if (newTickets.length > 0) {
  newTickets.slice(0, 5).forEach(t => console.log(`  ${t.key}: ${t.fields.summary?.slice(0,60)}`));
}

// ── Apply changes ──────────────────────────────────────────────────────────
if (!DRY_RUN) {
  // Fill existing tickets
  if (fills.length > 0) {
    console.log(`\nFilling PM/combo for ${fills.length} tickets...`);
    let done = 0;
    for (const f of fills) {
      const sets = [], vals = [];
      if (f.pm)    { sets.push(`"projectManager" = $${sets.length+1}`); vals.push(f.pm); }
      if (f.combo) { sets.push(`combination = $${sets.length+1}`); vals.push(f.combo); }
      if (f.pt)    { sets.push(`"productType" = $${sets.length+1}`); vals.push(f.pt); }
      if (f.cust)  { sets.push(`"customerName" = $${sets.length+1}`); vals.push(f.cust); }
      vals.push(f.id);
      if (sets.length > 0) {
        await pool.query(`UPDATE issues SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
        done++;
      }
    }
    console.log(`Done filling ${done} tickets.`);
  }

  // Import new tickets
  if (newTickets.length > 0) {
    console.log(`\nImporting ${newTickets.length} new CFITS tickets...`);
    // Get next L1BOAR number
    const maxL1 = (await pool.query(`SELECT MAX(CAST(SPLIT_PART(key,'-',2) AS INTEGER)) m FROM issues WHERE key LIKE 'L1BOAR-%'`)).rows[0].m || 7616;
    let nextNum = maxL1 + 1;
    let imported = 0;

    // Get default space/dept info
    const spaceRow = (await pool.query(`SELECT id FROM spaces WHERE key = 'L1BOAR' LIMIT 1`)).rows[0];
    const spaceId = spaceRow?.id;

    for (const issue of newTickets) {
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

      try {
        await pool.query(`
          INSERT INTO issues (
            key, cf_key, summary, status, priority,
            "projectManager", combination, "productType", "customerName",
            current_department, "spaceId",
            jira_assignee_name, jira_reporter_name,
            "createdAt", "updatedAt"
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Migration',$10,$11,$12,NOW(),NOW())
          ON CONFLICT (key) DO NOTHING
        `, [newKey, issue.key, summary, status, priority, pm, combo, pt, cust, spaceId, assigneeName, reporterName]);
        imported++;
        if (imported % 20 === 0) console.log(`  ${imported}/${newTickets.length}...`);
      } catch(e) {
        console.log(`  Error inserting ${newKey}: ${e.message}`);
      }
    }
    console.log(`Imported ${imported} new tickets.`);
  }
} else {
  console.log('\nRun with --apply to write changes.');
}

// ── Final stats ────────────────────────────────────────────────────────────
if (DRY_RUN) {
  const after = await pool.query(`
    SELECT
      COUNT(*) total,
      COUNT(CASE WHEN "projectManager" IS NULL OR "projectManager"='' OR "projectManager"='null' THEN 1 END) missing_pm,
      COUNT(CASE WHEN combination IS NULL OR combination='' OR combination='null' THEN 1 END) missing_combo
    FROM issues WHERE current_department = 'Migration'
  `);
  const a = after.rows[0];
  console.log(`\nCurrent state: total=${a.total} missing_pm=${a.missing_pm} missing_combo=${a.missing_combo}`);
}

await pool.end();
