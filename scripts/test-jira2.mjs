const JIRA_EMAIL = 'sujana.manapuram@cloudfuze.com';
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const BASE = 'https://cf2020.atlassian.net';

async function jira(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers||{}) }
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

// Test auth
console.log('Test auth:');
const me = await jira('/rest/api/3/myself');
console.log(`  Status: ${me.status}`);
console.log(`  Body: ${me.body.slice(0,300)}\n`);

// Test single ticket
console.log('Test single CF-27272:');
const single = await jira('/rest/api/3/issue/CF-27272?fields=summary,customfield_11380,customfield_10236,customfield_10203');
console.log(`  Status: ${single.status}`);
console.log(`  Body: ${single.body.slice(0,500)}\n`);

// Test JQL GET
console.log('Test JQL GET (CFITS project latest):');
const jql = await jira('/rest/api/3/search?jql=project%3DCFITS%20ORDER%20BY%20created%20DESC&maxResults=3&fields=summary,customfield_11380,customfield_10236');
console.log(`  Status: ${jql.status}`);
console.log(`  Body: ${jql.body.slice(0,800)}\n`);

// Test CFITSA project
console.log('Test CFITSA project:');
const cfitsa = await jira('/rest/api/3/search?jql=project%3DCFITSA%20ORDER%20BY%20created%20DESC&maxResults=3&fields=summary');
console.log(`  Status: ${cfitsa.status}`);
console.log(`  Body: ${cfitsa.body.slice(0,300)}\n`);
