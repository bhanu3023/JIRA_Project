import pg from 'pg';
const JIRA_EMAIL = 'sujana.manapuram@cloudfuze.com';
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const BASE = 'https://cf2020.atlassian.net';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

async function jira(path, body = null) {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: res.status, data: await res.json() };
}

// Check cf_key patterns in DB
const cfKeyPatterns = await pool.query(`
  SELECT
    LEFT(cf_key, POSITION('-' IN cf_key) - 1) prefix,
    COUNT(*) cnt,
    MIN(cf_key) min_key, MAX(cf_key) max_key
  FROM issues WHERE cf_key IS NOT NULL AND cf_key LIKE '%-%'
  GROUP BY 1 ORDER BY cnt DESC LIMIT 10
`);
console.log('cf_key prefixes in DB:');
cfKeyPatterns.rows.forEach(r => console.log(`  ${r.prefix}: ${r.cnt} (${r.min_key} to ${r.max_key})`));

// Try fetching CFITS-1 to understand the mapping
console.log('\nFetch CFITS-1:');
const t1 = await jira('/rest/api/3/issue/CFITS-1?fields=summary,customfield_11380,customfield_10236,customfield_10203');
console.log(`  Status: ${t1.status}`);
if (t1.data.fields) console.log(`  ${t1.data.key}: ${t1.data.fields.summary?.slice(0,60)}`);

// Get CFITS tickets in ascending order to see the range
console.log('\nCFITS tickets in ascending order:');
const cfitsAsc = await jira('/rest/api/3/search/jql', {
  jql: 'project = CFITS ORDER BY key ASC',
  fields: ['summary', 'customfield_11380', 'customfield_10236', 'customfield_10203'],
  maxResults: 5
});
cfitsAsc.data.issues?.forEach(i => {
  const f = i.fields;
  const pm = f.customfield_11380?.value || f.customfield_11380?.displayName || '-';
  const combo = f.customfield_10236?.value || '-';
  console.log(`  ${i.key}: PM="${pm}" combo="${combo}" | ${f.summary?.slice(0,50)}`);
});

// Try CF project with JQL like key = CF-29238
console.log('\nSearch for CF-29238 by JQL:');
const cfSearch = await jira('/rest/api/3/search/jql', {
  jql: 'key = "CF-29238"',
  fields: ['summary', 'customfield_11380', 'customfield_10236'],
  maxResults: 1
});
console.log(`  Status: ${cfSearch.status}, issues: ${cfSearch.data.issues?.length}`);
if (cfSearch.data.issues?.length > 0) {
  const i = cfSearch.data.issues[0];
  console.log(`  ${i.key}: ${i.fields.summary}`);
  console.log(`  PM: ${JSON.stringify(i.fields.customfield_11380)?.slice(0,100)}`);
  console.log(`  combo: ${JSON.stringify(i.fields.customfield_10236)?.slice(0,100)}`);
} else {
  console.log(`  Error: ${JSON.stringify(cfSearch.data).slice(0,200)}`);
}

// Try a range of CF keys to find which ones exist
console.log('\nSearch CF-27000 to CF-27010:');
const cfRange = await jira('/rest/api/3/search/jql', {
  jql: 'project = "CF" AND key >= "CF-27000" AND key <= "CF-27010" ORDER BY key ASC',
  fields: ['summary'],
  maxResults: 15
});
console.log(`  Status: ${cfRange.status}`);
if (cfRange.data.issues) {
  console.log(`  Total: ${cfRange.data.total}`);
  cfRange.data.issues?.forEach(i => console.log(`  ${i.key}: ${i.fields.summary?.slice(0,50)}`));
} else {
  console.log(`  Error: ${JSON.stringify(cfRange.data).slice(0,200)}`);
}

await pool.end();
