import https from 'https';

const JIRA_BASE = 'cf2020.atlassian.net';
const JIRA_EMAIL = 'sujana.manapuram@cloudfuze.com';
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

function jiraGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: JIRA_BASE, path, headers: { Authorization: AUTH, Accept: 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 2000) }));
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
      res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 3000) }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Test 1: Simple auth check
console.log('Test 1: Auth check (myself)');
const me = await jiraGet('/rest/api/3/myself');
console.log(`  Status: ${me.status}`);
console.log(`  Body: ${me.body.slice(0, 200)}\n`);

// Test 2: Single issue fetch
console.log('Test 2: Fetch single CF ticket');
const single = await jiraGet('/rest/api/3/issue/CF-27272?fields=summary,customfield_11380,customfield_10236,customfield_10203');
console.log(`  Status: ${single.status}`);
console.log(`  Body: ${single.body.slice(0, 500)}\n`);

// Test 3: JQL search - try both old and new endpoint
console.log('Test 3: JQL search (GET)');
const search = await jiraGet('/rest/api/3/search?jql=project%3DCFITS%20ORDER%20BY%20created%20DESC&maxResults=2&fields=summary,customfield_11380');
console.log(`  Status: ${search.status}`);
console.log(`  Body: ${search.body.slice(0, 500)}\n`);

// Test 4: POST search
console.log('Test 4: POST JQL search');
const postSearch = await jiraPost({
  jql: 'project = CFITS ORDER BY created DESC',
  fields: ['summary', 'customfield_11380', 'customfield_10236'],
  maxResults: 2
});
console.log(`  Status: ${postSearch.status}`);
console.log(`  Body: ${postSearch.body.slice(0, 500)}\n`);

// Test 5: Check CFITSA project
console.log('Test 5: Check CFITSA project');
const cfitsa = await jiraGet('/rest/api/3/search?jql=project%3DCFITSA%20ORDER%20BY%20created%20DESC&maxResults=2&fields=summary');
console.log(`  Status: ${cfitsa.status}`);
console.log(`  Body: ${cfitsa.body.slice(0, 500)}\n`);
