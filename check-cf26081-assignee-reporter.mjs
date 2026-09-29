// User noticed CF-26081 (one of the 48 just-backfilled Cloudsoft tickets)
// shows "Unassigned" and no Reporter in Filters. Checking whether that's
// genuinely true in the DB (a real historical data gap, e.g. from Jira
// import) or a display bug where the data exists but isn't rendering.
//
// Read-only.
//
// Usage: node check-cf26081-assignee-reporter.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT i.key, i.cf_key, i."assigneeId", i."reporterId", i.jira_source_key, i.jira_assignee_name, i.jira_reporter_name,
            a.id AS assignee_real_id, a."firstName" AS assignee_fn,
            r.id AS reporter_real_id, r."firstName" AS reporter_fn
     FROM issues i
     LEFT JOIN users a ON a.id = i."assigneeId"
     LEFT JOIN users r ON r.id = i."reporterId"
     WHERE i.key = 'CF-26081' OR i.cf_key = 'CF-26081'`
  );
  console.log(JSON.stringify(rows[0], null, 2));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
