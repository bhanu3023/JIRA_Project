// Pulls the REAL "updated" field directly from Jira for a sample of
// Kiran's QA-XXX tickets (confirmed the internal `key` column IS the
// real Jira issue key), and compares against our local (corrupted)
// updatedAt. If Jira's values are genuinely different/varied, this
// confirms the true dates ARE recoverable from the authoritative
// source, not permanently lost. Read-only against both systems.
//
// Usage: node check-jira-real-updated-dates.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JIRA_EMAIL = 'sujana.manapuram@cloudfuze.com';
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const BASE = 'https://cf2020.atlassian.net';
const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

async function main() {
  const { rows: sample } = await pool.query(`
    SELECT key, COALESCE(cf_key, key) AS cf_key, "updatedAt", "createdAt"
    FROM issues
    WHERE "assigneeId" = 'pg_vg1syvt79q' AND LOWER(current_department) = 'qa'
      AND key ~ '^QA-[0-9]+$'
    ORDER BY RANDOM()
    LIMIT 10
  `);

  console.log(`Checking ${sample.length} real Jira keys against the live QA project...\n`);
  const keys = sample.map(s => s.key);
  const jql = `key in (${keys.join(',')})`;
  const res = await fetch(`${BASE}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql, fields: ['summary', 'created', 'updated'], maxResults: 50 }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) { console.log('Jira API error:', res.status, JSON.stringify(data)); await pool.end(); return; }

  const byKey = new Map((data.issues || []).map(i => [i.key, i.fields]));
  for (const s of sample) {
    const jiraFields = byKey.get(s.key);
    if (!jiraFields) { console.log(`${s.key}: NOT FOUND in Jira (deleted/moved?)`); continue; }
    console.log(`${s.key} (${s.cf_key}):`);
    console.log(`  local  createdAt=${s.createdAt?.toISOString?.()}  updatedAt=${s.updatedAt?.toISOString?.()}`);
    console.log(`  JIRA   created=${jiraFields.created}  updated=${jiraFields.updated}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
