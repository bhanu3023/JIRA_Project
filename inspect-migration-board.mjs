/**
 * inspect-migration-board.mjs
 * READ-ONLY diagnostic. Checks how big the assignee/reporter gap actually
 * is on the Migration board (L1BOAR-*), and -- since migrate-cfits.js
 * generated local keys positionally (L1BOAR-N does NOT correspond to the
 * real Jira CFITS-N), unlike QA where local key = real Jira key -- checks
 * whether matching by normalized summary against live Jira is even viable
 * (unique match rate) before building any fix script that would rely on it.
 *
 * Run: JIRA_EMAIL=... JIRA_TOKEN=... DATABASE_URL=... node inspect-migration-board.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || 'https://cf2020.atlassian.net').trim();
const JIRA_EMAIL = (process.env.JIRA_EMAIL || '').trim();
const JIRA_TOKEN = (process.env.JIRA_TOKEN || '').trim();

const normalize = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

async function jiraFetch(path, opts = {}) {
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const res = await fetch(`${JIRA_BASE_URL}${path}`, {
    ...opts,
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  console.log('========== LOCAL: Migration (L1BOAR-*) gap ==========');
  const total = await pool.query(`SELECT COUNT(*) AS n FROM issues WHERE key LIKE 'L1BOAR-%'`);
  const noAssignee = await pool.query(`SELECT COUNT(*) AS n FROM issues WHERE key LIKE 'L1BOAR-%' AND "assigneeId" IS NULL`);
  const noReporter = await pool.query(`SELECT COUNT(*) AS n FROM issues WHERE key LIKE 'L1BOAR-%' AND "reporterId" IS NULL`);
  const extUsersAssigned = await pool.query(`
    SELECT COUNT(*) AS n FROM issues i JOIN users u ON u.id = i."assigneeId" WHERE i.key LIKE 'L1BOAR-%' AND u.id LIKE 'ext_%'
  `);
  console.log(`Total L1BOAR-* tickets: ${total.rows[0].n}`);
  console.log(`  with NULL assigneeId: ${noAssignee.rows[0].n}`);
  console.log(`  with NULL reporterId: ${noReporter.rows[0].n}`);
  console.log(`  currently assigned to a disconnected ext_* placeholder user: ${extUsersAssigned.rows[0].n}`);

  const sample = await pool.query(`
    SELECT key, summary, "assigneeId", "reporterId", "createdAt"
    FROM issues WHERE key LIKE 'L1BOAR-%' AND ("assigneeId" IS NULL OR "reporterId" IS NULL)
    ORDER BY RANDOM() LIMIT 10
  `);
  console.log('\nSample of gapped tickets:');
  console.log(JSON.stringify(sample.rows, null, 2));

  if (!JIRA_EMAIL || !JIRA_TOKEN) {
    console.log('\nJIRA_EMAIL/JIRA_TOKEN not set -- skipping the Jira-side match-rate check.');
    await pool.end();
    return;
  }

  console.log('\n========== JIRA: summary-match viability for CFITS ==========');
  // Pull the same 10 gapped tickets' summaries and see how many resolve to
  // exactly one Jira CFITS issue by normalized summary.
  let matched = 0, ambiguous = 0, notFound = 0;
  for (const row of sample.rows) {
    const norm = normalize(row.summary);
    if (!norm) { notFound++; continue; }
    const jql = `project = CFITS AND summary ~ ${JSON.stringify(row.summary.replace(/"/g, '\\"'))}`;
    const { status, json } = await jiraFetch('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql, maxResults: 10, fields: ['summary'] }),
    });
    if (status !== 200 || !json?.issues) { notFound++; continue; }
    const exact = json.issues.filter((i) => normalize(i.fields.summary) === norm);
    if (exact.length === 1) { matched++; console.log(`  MATCH: ${row.key} -> ${exact[0].key}`); }
    else if (exact.length > 1) { ambiguous++; console.log(`  AMBIGUOUS: ${row.key} matches ${exact.length} Jira issues: ${exact.map((i) => i.key).join(', ')}`); }
    else { notFound++; console.log(`  NOT FOUND in Jira CFITS: ${row.key} ("${row.summary}")`); }
  }
  console.log(`\nOf ${sample.rows.length} sampled gapped tickets: ${matched} unique match, ${ambiguous} ambiguous, ${notFound} not found.`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
