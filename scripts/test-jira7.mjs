const JIRA_EMAIL = 'sujana.manapuram@cloudfuze.com';
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const BASE = 'https://cf2020.atlassian.net';

async function jira(path, body = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(BASE + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
      signal: controller.signal,
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    clearTimeout(timer);
    const text = await res.text();
    return { status: res.status, raw: text };
  } catch(e) {
    clearTimeout(timer);
    throw e;
  }
}

// Test 1: Simple GET for CFITS latest
console.log('Test 1: GET CFITS latest 3 (deprecated endpoint):');
const t1 = await jira('/rest/api/3/search?jql=project%3DCFITS%20ORDER%20BY%20created%20DESC&maxResults=3&fields=summary');
console.log(`  Status: ${t1.status}`);
console.log(`  Body: ${t1.raw.slice(0, 500)}\n`);

// Test 2: POST to /rest/api/3/search/jql - raw body
console.log('Test 2: POST /rest/api/3/search/jql:');
const body2 = { jql: 'project = CFITS ORDER BY created DESC', fields: ['summary'], maxResults: 3 };
const t2 = await jira('/rest/api/3/search/jql', body2);
console.log(`  Status: ${t2.status}`);
console.log(`  Body: ${t2.raw.slice(0, 800)}\n`);

// Test 3: Try with nextPageToken approach
console.log('Test 3: POST with nextPageToken (new API):');
const body3 = { jql: 'project = CFITS ORDER BY created DESC', fields: ['summary', 'customfield_11380', 'customfield_10236', 'customfield_10203'], maxResults: 5 };
const t3 = await jira('/rest/api/3/search/jql', body3);
console.log(`  Status: ${t3.status}`);
console.log(`  Body: ${t3.raw.slice(0, 1000)}\n`);
