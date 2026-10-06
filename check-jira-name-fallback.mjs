// CF-22904 has assigneeId=null, reporterId=null, yet the live API
// returned the SAME name ("kondameedi ganesh") for both assignee and
// reporter. Checking the raw jira_assignee_name/jira_reporter_name
// import-time text columns to see if they actually differ (meaning
// reporter is wrongly falling back to the ASSIGNEE's raw name) or are
// genuinely the same person. Read-only.
//
// Usage: node check-jira-name-fallback.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const SAMPLE_KEYS = ['CF-22904', 'CF-12304', 'CF-8596', 'CF-8584', 'CF-31026'];

async function main() {
  const { rows } = await pool.query(`
    SELECT COALESCE(cf_key, key) AS key, "assigneeId", "reporterId", jira_assignee_name, jira_reporter_name
    FROM issues
    WHERE cf_key = ANY($1::text[]) OR key = ANY($1::text[])
  `, [SAMPLE_KEYS]);
  for (const r of rows) {
    console.log(`${r.key}: assigneeId=${r.assigneeId} reporterId=${r.reporterId} | jira_assignee_name=${JSON.stringify(r.jira_assignee_name)} jira_reporter_name=${JSON.stringify(r.jira_reporter_name)}`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
