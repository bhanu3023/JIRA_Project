/**
 * check-qa-assignee-drift.mjs
 * READ-ONLY. sync-qa-core-fields.mjs's dry run flagged assignee/reporter
 * as "changed" on ~90%+ of QA tickets -- before trusting that and writing
 * it for real, this shows exactly what's currently stored locally
 * (id, email, displayName) side by side with what Jira says, for a sample
 * of tickets, so we can tell a real correction apart from a matching bug.
 *
 * Run: DATABASE_URL=... node check-qa-assignee-drift.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

async function main() {
  const rows = await pool.query(`
    SELECT i.key, i."assigneeId", u.email AS assignee_email, u."displayName" AS assignee_name, u.id AS assignee_row_id
    FROM issues i
    LEFT JOIN users u ON u.id = i."assigneeId"
    WHERE i.key LIKE 'QA-%'
    ORDER BY RANDOM()
    LIMIT 15
  `);
  console.log('Current LOCAL assignee data for 15 random QA tickets:');
  console.log(JSON.stringify(rows.rows, null, 2));

  const nullAssignee = await pool.query(`SELECT COUNT(*) AS n FROM issues WHERE key LIKE 'QA-%' AND "assigneeId" IS NULL`);
  const extUsers = await pool.query(`SELECT COUNT(*) AS n FROM users WHERE id LIKE 'ext_%'`);
  const extUsersAssigned = await pool.query(`
    SELECT COUNT(*) AS n FROM issues i JOIN users u ON u.id = i."assigneeId" WHERE i.key LIKE 'QA-%' AND u.id LIKE 'ext_%'
  `);
  console.log(`\nQA tickets with NULL assigneeId: ${nullAssignee.rows[0].n}`);
  console.log(`Total users with an "ext_*" id (placeholder accounts from the original migration): ${extUsers.rows[0].n}`);
  console.log(`QA tickets currently assigned to one of those ext_* placeholder users: ${extUsersAssigned.rows[0].n}`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
