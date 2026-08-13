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

// Check if any cf_key starts with CFITS
const cfitsKeys = await pool.query(`SELECT COUNT(*) c FROM issues WHERE cf_key LIKE 'CFITS-%'`);
console.log(`cf_key CFITS-: ${cfitsKeys.rows[0].c}`);

// Get latest L1BOAR tickets and their summaries vs Jira CFITS
const latestL1 = await pool.query(`
  SELECT key, cf_key, summary FROM issues
  WHERE current_department = 'Migration'
  ORDER BY "createdAt" DESC LIMIT 10
`);
console.log('\nLatest L1BOAR tickets:');
latestL1.rows.forEach(r => console.log(`  ${r.key} cf_key="${r.cf_key}" | ${(r.summary||'').slice(0,50)}`));

// Fetch latest CFITS from Jira (to compare)
const cfitsLatest = await jira('/rest/api/3/search/jql', {
  jql: 'project = CFITS ORDER BY created DESC',
  fields: ['summary', 'customfield_11380', 'customfield_10236', 'customfield_10203', 'status', 'assignee', 'reporter', 'created', 'updated', 'priority', 'customfield_10401'],
  maxResults: 10
});
console.log('\nLatest CFITS tickets in Jira:');
cfitsLatest.data.issues?.forEach(i => {
  const f = i.fields;
  const pm = f.customfield_11380?.value || f.customfield_11380?.displayName || '-';
  const combo = f.customfield_10236?.value || '-';
  const cust = f.customfield_10401?.value || '-';
  console.log(`  ${i.key}: PM="${pm}" combo="${combo}" cust="${cust}" | ${f.summary?.slice(0,50)}`);
});

// Check total CFITS tickets vs DB
const cfitsCount = await jira('/rest/api/3/search/jql', {
  jql: 'project = CFITS',
  fields: ['summary'],
  maxResults: 1
});
console.log(`\nTotal CFITS in Jira: ${cfitsCount.data.total}`);

const dbL1Count = await pool.query(`SELECT COUNT(*) c FROM issues WHERE current_department = 'Migration'`);
console.log(`Total L1BOAR in DB: ${dbL1Count.rows[0].c}`);

// Check if recent L1BOAR summaries match CFITS summaries (to confirm the link)
// Take a sample of the newest L1BOAR tickets and see if they match recent CFITS
const newL1 = await pool.query(`
  SELECT key, cf_key, summary FROM issues
  WHERE current_department = 'Migration'
  ORDER BY "createdAt" DESC LIMIT 5
`);
for (const row of newL1.rows) {
  // Try to find this in CFITS by summary
  const summaryQuery = row.summary ? row.summary.substring(0, 30).replace(/['"\\]/g, '') : '';
  if (!summaryQuery) continue;
  const match = await jira('/rest/api/3/search/jql', {
    jql: `project = CFITS AND summary ~ "${summaryQuery}"`,
    fields: ['summary'],
    maxResults: 2
  });
  const found = match.data.issues?.map(i => i.key).join(', ') || 'none';
  console.log(`\n  L1: ${row.key} | cf_key: ${row.cf_key}`);
  console.log(`      summary: ${row.summary?.slice(0,50)}`);
  console.log(`      CFITS match: ${found}`);
}

await pool.end();
