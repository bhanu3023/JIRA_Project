// Scope the problem before attempting any recovery: how many tickets
// across the space are genuinely missing assignee and/or reporter (no
// id, no raw jira_*_name text either), and of those, how many have an
// emailthreadid on file at all -- the only possible lead toward
// recovering the REAL original sender via a live Microsoft Graph
// lookup. Read-only.
//
// Usage: node check-recoverable-reporters.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: totals } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE "assigneeId" IS NULL AND (jira_assignee_name IS NULL OR jira_assignee_name = '')) AS missing_assignee,
      COUNT(*) FILTER (WHERE "reporterId" IS NULL AND (jira_reporter_name IS NULL OR jira_reporter_name = '')) AS missing_reporter,
      COUNT(*) FILTER (WHERE "reporterId" IS NULL AND (jira_reporter_name IS NULL OR jira_reporter_name = '') AND emailthreadid IS NOT NULL AND emailthreadid != '') AS missing_reporter_with_thread,
      COUNT(*) FILTER (WHERE "assigneeId" IS NULL AND (jira_assignee_name IS NULL OR jira_assignee_name = '') AND emailthreadid IS NOT NULL AND emailthreadid != '') AS missing_assignee_with_thread,
      COUNT(*)::int AS total_issues
    FROM issues
  `);
  console.log(JSON.stringify(totals[0], null, 2));

  // Sample a few missing-reporter-with-thread tickets to see what the
  // emailthreadid actually looks like (format sanity check before
  // attempting any live Graph lookup)
  const { rows: sample } = await pool.query(`
    SELECT COALESCE(cf_key, key) AS key, emailthreadid, "spaceId"
    FROM issues
    WHERE "reporterId" IS NULL AND (jira_reporter_name IS NULL OR jira_reporter_name = '')
      AND emailthreadid IS NOT NULL AND emailthreadid != ''
    LIMIT 5
  `);
  console.log('\nSample recoverable-candidate tickets:');
  console.log(JSON.stringify(sample, null, 2));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
