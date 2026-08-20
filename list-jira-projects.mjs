/**
 * list-jira-projects.mjs
 * READ-ONLY. Lists every Jira project visible to the given credentials, to
 * find out whether "QUALITY-ANALYST" still exists (maybe under a different
 * key/name) or this token's account has lost access to it -- inspect-qa-board.mjs
 * found zero results searching for "QUALITY" or "QA", which could mean either.
 *
 * Run: JIRA_EMAIL=... JIRA_TOKEN=... node list-jira-projects.mjs
 */
const JIRA_BASE_URL = process.env.JIRA_BASE_URL || 'https://cf2020.atlassian.net';
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_TOKEN;

if (!JIRA_EMAIL || !JIRA_TOKEN) {
  console.error('Set JIRA_EMAIL and JIRA_TOKEN environment variables first.');
  process.exit(1);
}

async function main() {
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, Accept: 'application/json' };

  // Who does this token authenticate as? (confirms the token itself is valid)
  const me = await fetch(`${JIRA_BASE_URL}/rest/api/3/myself`, { headers });
  console.log(`GET /rest/api/3/myself -> HTTP ${me.status}`);
  console.log(await me.text());

  // All projects this account can see, no filter.
  const proj = await fetch(`${JIRA_BASE_URL}/rest/api/3/project/search?maxResults=200`, { headers });
  console.log(`\nGET /rest/api/3/project/search (no filter) -> HTTP ${proj.status}`);
  const json = await proj.json().catch(() => null);
  if (json?.values) {
    console.log(`Total projects visible: ${json.total}`);
    console.log(JSON.stringify(json.values.map(p => ({ id: p.id, key: p.key, name: p.name })), null, 2));
  } else {
    console.log(await proj.text());
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
