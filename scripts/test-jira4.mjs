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

// Check latest CF project tickets
console.log('Latest CF project tickets:');
const cf = await jira('/rest/api/3/search/jql', {
  jql: 'project = CF ORDER BY created DESC',
  fields: ['summary', 'customfield_11380', 'customfield_10236', 'customfield_10203'],
  maxResults: 5
});
console.log(`  Status: ${cf.status}, issues: ${cf.data.issues?.length}`);
cf.data.issues?.forEach(i => {
  const f = i.fields;
  const pm = f.customfield_11380?.value || f.customfield_11380?.displayName || '-';
  const combo = f.customfield_10236?.value || '-';
  const pt = f.customfield_10203?.value || '-';
  console.log(`  ${i.key}: PM="${pm}" combo="${combo}" pt="${pt}" | ${f.summary?.slice(0,50)}`);
});

// What's the max CF key?
console.log('\nMax CF key:');
const maxCF = await jira('/rest/api/3/search/jql', {
  jql: 'project = CF ORDER BY key DESC',
  fields: ['summary'],
  maxResults: 3
});
maxCF.data.issues?.forEach(i => console.log(`  ${i.key}: ${i.fields.summary?.slice(0,60)}`));

// Try CF-29238 (max in DB)
console.log('\nFetch CF-29238:');
const t29238 = await jira('/rest/api/3/issue/CF-29238?fields=summary,customfield_11380,customfield_10236,customfield_10203');
console.log(`  Status: ${t29238.status}`);
if (t29238.data.fields) {
  const f = t29238.data.fields;
  console.log(`  summary: ${f.summary}`);
  console.log(`  PM: ${JSON.stringify(f.customfield_11380)?.slice(0,100)}`);
  console.log(`  combo: ${JSON.stringify(f.customfield_10236)?.slice(0,100)}`);
}

// Check CFITS project - latest
console.log('\nLatest CFITS tickets with custom fields:');
const cfits = await jira('/rest/api/3/search/jql', {
  jql: 'project = CFITS ORDER BY created DESC',
  fields: ['summary', 'customfield_11380', 'customfield_10236', 'customfield_10203'],
  maxResults: 5
});
cfits.data.issues?.forEach(i => {
  const f = i.fields;
  const pm = f.customfield_11380?.value || f.customfield_11380?.displayName || '-';
  const combo = f.customfield_10236?.value || '-';
  const pt = f.customfield_10203?.value || '-';
  console.log(`  ${i.key}: PM="${pm}" combo="${combo}" pt="${pt}" | ${f.summary?.slice(0,50)}`);
});

// Check CFITS max key number
console.log('\nCFITS max key:');
const cfitsMax = await jira('/rest/api/3/search/jql', {
  jql: 'project = CFITS ORDER BY key DESC',
  fields: ['summary'],
  maxResults: 3
});
cfitsMax.data.issues?.forEach(i => console.log(`  ${i.key}: ${i.fields.summary?.slice(0,50)}`));
