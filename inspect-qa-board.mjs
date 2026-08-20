/**
 * inspect-qa-board.mjs
 *
 * READ-ONLY diagnostic. Before writing any fetch/reconcile logic for the
 * QA board, this nails down facts the codebase currently disagrees with
 * itself about:
 *   - the real local issue-key prefix for QA tickets today (different
 *     scripts assume QA-, QAB-, or QABOAR- -- an old DB snapshot in this
 *     repo shows QA- but may itself be stale)
 *   - the real Jira project key/id behind the "QUALITY-ANALYST" board name
 *   - how much of created/updated/assignee/reporter/status/history/
 *     comments/subtasks/links data is actually present locally already,
 *     vs. missing/never-populated
 *
 * Nothing is written anywhere. Credentials are read from env vars only --
 * never hardcode JIRA_EMAIL/JIRA_TOKEN in this file or any committed
 * script; several older scripts in this repo already do that and the
 * token should be treated as exposed.
 *
 * Env vars:
 *   DATABASE_URL          - optional, defaults to the local dev DB
 *   JIRA_BASE_URL         - optional, defaults to https://cf2020.atlassian.net
 *   JIRA_EMAIL, JIRA_TOKEN - required for the Jira-side checks (local DB
 *                            checks still run without them)
 *
 * Run:
 *   JIRA_EMAIL=you@co.com JIRA_TOKEN=xxx DATABASE_URL=... node inspect-qa-board.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || 'https://cf2020.atlassian.net').trim();
// .trim() guards against trailing whitespace/newlines picked up from a
// pasted multi-line env var assignment.
const JIRA_EMAIL = (process.env.JIRA_EMAIL || '').trim();
const JIRA_TOKEN = (process.env.JIRA_TOKEN || '').trim();

async function jiraFetch(path) {
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const res = await fetch(`${JIRA_BASE_URL}${path}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function inspectLocalDb() {
  console.log('\n========== LOCAL DATABASE ==========');

  const prefixes = await pool.query(`
    SELECT substring(key from '^[A-Za-z]+') AS prefix, COUNT(*) AS n
    FROM issues
    WHERE key ~ '^(QA|QAB|QABOAR)-?[0-9]+$' OR key ILIKE 'QA%' OR key ILIKE 'QAB%'
    GROUP BY prefix ORDER BY n DESC
  `);
  console.log('Key prefixes matching QA/QAB/QABOAR:');
  console.log(JSON.stringify(prefixes.rows, null, 2));

  if (prefixes.rows.length === 0) {
    console.log('No QA-ish issues found under any of those prefixes -- check the space/department config instead.');
    return null;
  }

  const mainPrefix = prefixes.rows[0].prefix;
  console.log(`\nTreating "${mainPrefix}" as the real prefix for the rest of this check (most rows).`);

  const total = await pool.query(`SELECT COUNT(*) AS n FROM issues WHERE key LIKE $1`, [`${mainPrefix}-%`]);
  const parentPop = await pool.query(`SELECT COUNT(*) AS n FROM issues WHERE key LIKE $1 AND "parentKey" IS NOT NULL`, [`${mainPrefix}-%`]);
  const historyCount = await pool.query(`
    SELECT COUNT(*) AS n FROM issue_history h JOIN issues i ON i.id = h."issueId" WHERE i.key LIKE $1
  `, [`${mainPrefix}-%`]);
  const commentCount = await pool.query(`
    SELECT COUNT(*) AS n FROM comments c JOIN issues i ON i.id = c."issueId" WHERE i.key LIKE $1
  `, [`${mainPrefix}-%`]);
  const updatedEqCreated = await pool.query(`
    SELECT COUNT(*) AS n FROM issues WHERE key LIKE $1 AND "updatedAt" = "createdAt"
  `, [`${mainPrefix}-%`]);
  const linksAsSource = await pool.query(`SELECT COUNT(*) AS n FROM issue_links WHERE "sourceKey" LIKE $1`, [`${mainPrefix}%`]);
  const linksOrphaned = await pool.query(`
    SELECT COUNT(*) AS n FROM issue_links il
    WHERE il."sourceKey" LIKE $1 AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.key = il."sourceKey")
  `, [`${mainPrefix}%`]);

  console.log(`\nTotal ${mainPrefix}-* issues: ${total.rows[0].n}`);
  console.log(`  with parentKey set:            ${parentPop.rows[0].n}`);
  console.log(`  with updatedAt === createdAt:  ${updatedEqCreated.rows[0].n}  (suspicious -- likely never got a real 'updated' from Jira)`);
  console.log(`  issue_history rows (total):    ${historyCount.rows[0].n}`);
  console.log(`  comment rows (total):          ${commentCount.rows[0].n}`);
  console.log(`  issue_links as source:         ${linksAsSource.rows[0].n}`);
  console.log(`  ...of which orphaned (sourceKey doesn't match any current issue): ${linksOrphaned.rows[0].n}`);

  const sample = await pool.query(`
    SELECT key, "createdAt", "updatedAt", "parentKey", "statusId" FROM issues WHERE key LIKE $1 ORDER BY key LIMIT 5
  `, [`${mainPrefix}-%`]);
  console.log('\nSample rows:');
  console.log(JSON.stringify(sample.rows, null, 2));

  return mainPrefix;
}

async function inspectJira() {
  console.log('\n========== JIRA ==========');
  if (!JIRA_EMAIL || !JIRA_TOKEN) {
    console.log('JIRA_EMAIL/JIRA_TOKEN not set -- skipping Jira-side checks.');
    return;
  }

  const search = await jiraFetch('/rest/api/3/project/search?query=QUALITY');
  console.log(`GET /rest/api/3/project/search?query=QUALITY -> HTTP ${search.status}`);
  if (search.json?.values) {
    console.log(JSON.stringify(search.json.values.map(p => ({ id: p.id, key: p.key, name: p.name })), null, 2));
  } else {
    console.log(search.text.slice(0, 500));
  }

  const qaSearch = await jiraFetch('/rest/api/3/project/search?query=QA');
  console.log(`\nGET /rest/api/3/project/search?query=QA -> HTTP ${qaSearch.status}`);
  if (qaSearch.json?.values) {
    console.log(JSON.stringify(qaSearch.json.values.map(p => ({ id: p.id, key: p.key, name: p.name })), null, 2));
  }

  // Try both likely project keys for a sample issue with the full field set we care about.
  for (const projectKey of ['QA', 'QAB']) {
    const body = {
      jql: `project=${projectKey} ORDER BY created DESC`,
      maxResults: 1,
      fields: ['summary', 'status', 'assignee', 'reporter', 'created', 'updated', 'parent', 'subtasks', 'issuelinks', 'comment'],
    };
    const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
    const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`\nProject "${projectKey}" sample issue search -> HTTP ${res.status}`);
    try {
      const json = JSON.parse(text);
      if (json.issues?.length) {
        const iss = json.issues[0];
        console.log(`  Sample: ${iss.key} -- ${iss.fields.summary}`);
        console.log(`  status=${iss.fields.status?.name}, assignee=${iss.fields.assignee?.displayName}, reporter=${iss.fields.reporter?.displayName}`);
        console.log(`  created=${iss.fields.created}, updated=${iss.fields.updated}`);
        console.log(`  parent=${iss.fields.parent?.key || null}, subtasks=${(iss.fields.subtasks || []).map(s => s.key)}`);
        console.log(`  issuelinks=${(iss.fields.issuelinks || []).length}, comments=${iss.fields.comment?.total ?? 'n/a'}`);
      } else {
        console.log(`  ${text.slice(0, 300)}`);
      }
    } catch {
      console.log(`  Non-JSON response: ${text.slice(0, 300)}`);
    }
  }
}

async function main() {
  await inspectLocalDb();
  await inspectJira();
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
