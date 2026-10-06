// Two things: (1) confirm the JIRA_TOKEN env var still works against the
// live cf2020.atlassian.net Jira instance and find the QUALITY_ANALYST
// project's real key, (2) check whether Kiran's QA tickets have a
// jira_source_key mapping back to the original Jira issue, which is
// needed to pull the TRUE "updated" field directly from Jira itself
// (the authoritative source) rather than our corrupted local copy.
// Read-only against both systems.
//
// Usage: node check-jira-connection-and-mapping.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JIRA_EMAIL = 'sujana.manapuram@cloudfuze.com';
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const BASE = 'https://cf2020.atlassian.net';
const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

async function main() {
  console.log('JIRA_TOKEN set?', !!JIRA_TOKEN);

  if (JIRA_TOKEN) {
    try {
      const meRes = await fetch(`${BASE}/rest/api/3/myself`, { headers: { Authorization: AUTH, Accept: 'application/json' } });
      console.log('Auth check status:', meRes.status);

      const projRes = await fetch(`${BASE}/rest/api/3/project/search?query=quality`, { headers: { Authorization: AUTH, Accept: 'application/json' } });
      const projData = await projRes.json().catch(() => null);
      console.log('Projects matching "quality":', JSON.stringify((projData?.values || []).map(p => ({ key: p.key, name: p.name })), null, 2));

      // Also list ALL projects, in case "Quality Analyst" is named
      // differently -- QA-related spaces might not literally contain
      // the word "quality" in their project name.
      const allRes = await fetch(`${BASE}/rest/api/3/project/search?maxResults=100`, { headers: { Authorization: AUTH, Accept: 'application/json' } });
      const allData = await allRes.json().catch(() => null);
      console.log('\nAll projects:', JSON.stringify((allData?.values || []).map(p => ({ key: p.key, name: p.name })), null, 2));
    } catch (e) {
      console.log('Jira API error:', e.message);
    }
  }

  // DB side: does Kiran's QA tickets have jira_source_key populated?
  const { rows: kiranQa } = await pool.query(`
    SELECT COALESCE(cf_key, key) AS key, jira_source_key, "updatedAt"
    FROM issues
    WHERE "assigneeId" = 'pg_vg1syvt79q' AND LOWER(current_department) = 'qa'
    LIMIT 10
  `);
  console.log('\nSample of Kiran\'s QA tickets -- jira_source_key mapping:');
  console.log(JSON.stringify(kiranQa, null, 2));

  const { rows: sourceKeyStats } = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE jira_source_key IS NOT NULL) AS with_source_key,
           COUNT(*) AS total
    FROM issues
  `);
  console.log('\nOverall jira_source_key coverage:', JSON.stringify(sourceKeyStats[0]));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
