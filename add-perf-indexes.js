// Connection string was hardcoded to a stale host/db (localhost:5433/neutara_db)
// from an earlier infrastructure iteration -- this app's actual production
// database is postgresql://jirauser:...@localhost:5434/jiradb (see .env.server),
// so running this script never actually touched the real database it was meant
// to index. Use DATABASE_URL like every other script in this repo instead of a
// second, independently-maintained (and silently stale) copy of the connection
// details.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const indexes = [
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issues_cf_key ON issues(cf_key)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issues_current_dept ON issues(current_department)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issues_space_dept ON issues("spaceId", current_department)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issues_created_desc ON issues("createdAt" DESC)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issues_summary_gin ON issues USING gin(to_tsvector('english', summary))`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issue_dept_transitions_issue_id ON issue_dept_transitions(issue_id)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_queue_closed_issue_id ON queue_closed_tickets(issue_id)`,
  ];

  for (const sql of indexes) {
    try {
      console.log('Creating:', sql.split(' ')[6]);
      await pool.query(sql);
      console.log('  ✓ done');
    } catch (e) {
      console.log('  - skipped:', e.message.split('\n')[0]);
    }
  }
  await pool.end();
}
main().catch(console.error);
