/**
 * check-qa-key-alignment.mjs
 * READ-ONLY. Determines whether local QA-N keys are the SAME tickets as
 * real Jira QA-N (i.e. numbering is aligned and matching by key is safe),
 * or a separate local numbering scheme that happens to reuse the "QA-"
 * prefix (in which case reconciliation must match by summary instead, the
 * way sync-qa-descriptions.mjs already does for exactly this reason).
 *
 * Fetches a handful of keys directly from both sides and compares summary
 * + created date.
 *
 * Run: JIRA_EMAIL=... JIRA_TOKEN=... DATABASE_URL=... node check-qa-key-alignment.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || 'https://cf2020.atlassian.net').trim();
const JIRA_EMAIL = (process.env.JIRA_EMAIL || '').trim();
const JIRA_TOKEN = (process.env.JIRA_TOKEN || '').trim();

const SAMPLE_KEYS = ['QA-1', 'QA-10', 'QA-100', 'QA-1000', 'QA-1001', 'QA-500', 'QA-1200'];

async function jiraGetIssue(key) {
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${key}?fields=summary,created`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (res.status !== 200) return { status: res.status };
  const json = await res.json();
  return { status: 200, summary: json.fields.summary, created: json.fields.created };
}

async function main() {
  for (const key of SAMPLE_KEYS) {
    const local = await pool.query(`SELECT summary, "createdAt" FROM issues WHERE key = $1`, [key]);
    const jira = await jiraGetIssue(key);
    console.log(`\n${key}`);
    console.log(`  LOCAL: ${local.rows[0] ? `"${local.rows[0].summary}" (created ${local.rows[0].createdAt.toISOString()})` : 'not found'}`);
    console.log(`  JIRA:  ${jira.status === 200 ? `"${jira.summary}" (created ${jira.created})` : `HTTP ${jira.status}`}`);
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
