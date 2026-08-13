const JIRA_EMAIL = 'sujana.manapuram@cloudfuze.com';
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const BASE = 'https://cf2020.atlassian.net';

async function jira(path, body = null) {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: res.status, data: await res.json() };
}

// List all accessible projects
console.log('Accessible projects:');
const projects = await jira('/rest/api/3/project/search?maxResults=50');
if (projects.data.values) {
  projects.data.values.forEach(p => console.log(`  ${p.key}: ${p.name}`));
}

// Try POST JQL for CFITS
console.log('\nCFITS project tickets (POST):');
const cfits = await jira('/rest/api/3/search/jql', {
  jql: 'project = CFITS ORDER BY created DESC',
  fields: ['summary', 'customfield_11380', 'customfield_10236'],
  maxResults: 3
});
console.log(`  Status: ${cfits.status}`);
console.log(`  Total: ${cfits.data.total}`);
cfits.data.issues?.slice(0,3).forEach(i => console.log(`  ${i.key}: ${i.fields.summary?.slice(0,60)}`));

// Try CFITSA
console.log('\nCFITSA project tickets (POST):');
const cfitsa = await jira('/rest/api/3/search/jql', {
  jql: 'project = CFITSA ORDER BY created DESC',
  fields: ['summary'],
  maxResults: 3
});
console.log(`  Status: ${cfitsa.status}`);
if (cfitsa.data.issues) {
  console.log(`  Total: ${cfitsa.data.total}`);
  cfitsa.data.issues.slice(0,3).forEach(i => console.log(`  ${i.key}: ${i.fields.summary?.slice(0,60)}`));
} else {
  console.log(`  Error: ${JSON.stringify(cfitsa.data).slice(0,200)}`);
}

// Try fetching CFITS-27272 directly (different key format)
console.log('\nFetch CFITS-27272:');
const t1 = await jira('/rest/api/3/issue/CFITS-27272?fields=summary,customfield_11380,customfield_10236');
console.log(`  Status: ${t1.status}, body: ${JSON.stringify(t1.data).slice(0,200)}`);
