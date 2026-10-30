// Read-only: how many locally-imported QA-project tickets (key LIKE 'QA-%',
// imported from Jira's "QUALITY-ANALYST" project, key QA) are missing
// assignee/reporter/status, and spot-check a few against live Jira to
// confirm whether Jira actually HAS that data (meaning the import/sync
// missed it) or genuinely doesn't (meaning there's nothing to backfill).
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function getJiraCreds() {
  const { rows } = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('jira_url','jira_email','jira_token')`);
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  const base = s.jira_url || process.env.JIRA_BASE_URL || 'https://cf2020.atlassian.net';
  const email = s.jira_email || process.env.JIRA_EMAIL || '';
  const token = s.jira_token || process.env.JIRA_TOKEN || '';
  const authHdr = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  return { base, authHdr };
}

async function main() {
  const { rows: counts } = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE "assigneeId" IS NULL)::int AS no_assignee,
      COUNT(*) FILTER (WHERE "reporterId" IS NULL)::int AS no_reporter,
      COUNT(*) FILTER (WHERE "statusId" IS NULL)::int AS no_status
    FROM issues WHERE key LIKE 'QA-%'
  `);
  console.log('QA-project tickets (local):', counts[0]);

  const { rows: sample } = await pool.query(`
    SELECT i.key, i.cf_key, i.summary, i."assigneeId", i."reporterId", s.name AS status_name
    FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE i.key LIKE 'QA-%' AND (i."assigneeId" IS NULL OR i."reporterId" IS NULL)
    ORDER BY i."createdAt" DESC
    LIMIT 8
  `);
  console.log(`\nSample of ${sample.length} local tickets missing assignee/reporter:`);
  for (const r of sample) console.log(` - ${r.key} (${r.cf_key}) | assignee=${r.assigneeId || 'NULL'} reporter=${r.reporterId || 'NULL'} status=${r.status_name || 'NULL'} | "${(r.summary||'').slice(0,50)}"`);

  if (!sample.length) { await pool.end(); return; }

  const { base, authHdr } = await getJiraCreds();
  console.log(`\nChecking live Jira (${base}) for those same keys:`);
  for (const r of sample) {
    try {
      const res = await fetch(`${base}/rest/api/3/issue/${r.key}?fields=summary,status,assignee,reporter`, {
        headers: { Authorization: authHdr, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { console.log(` - ${r.key}: Jira HTTP ${res.status}`); continue; }
      const ji = await res.json();
      const f = ji.fields || {};
      console.log(` - ${r.key}: Jira status="${f.status?.name}" assignee="${f.assignee?.displayName || 'Unassigned'}" reporter="${f.reporter?.displayName || 'none'}"`);
    } catch (e) {
      console.log(` - ${r.key}: fetch failed -- ${e?.message || e}`);
    }
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
