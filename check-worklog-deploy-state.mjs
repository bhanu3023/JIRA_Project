// User says the Worklog tab isn't showing on the ticket detail page.
// Checking whether the deploy actually picked up the feature (table
// exists, notification_log table exists) before assuming it's just a
// scroll/UI issue. Read-only.
//
// Usage: node check-worklog-deploy-state.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_name IN ('issue_worklogs', 'notification_log')`
  );
  console.log('Tables found:', rows.map(r => r.table_name));
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
