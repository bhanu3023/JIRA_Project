// jira_source_key is null for Kiran's QA tickets, but the internal
// `key` column (not the display cf_key) might itself be the native
// Jira key for whichever board this ticket was imported from -- e.g.
// "QA-1234" would directly map to the real QUALITY-ANALYST Jira
// project. Checking the raw key format for her tickets. Read-only.
//
// Usage: node check-kiran-real-jira-key.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT key, cf_key, jira_source_key, "updatedAt", "createdAt"
    FROM issues
    WHERE "assigneeId" = 'pg_vg1syvt79q' AND LOWER(current_department) = 'qa'
    ORDER BY RANDOM()
    LIMIT 15
  `);
  console.log(JSON.stringify(rows, null, 2));
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
