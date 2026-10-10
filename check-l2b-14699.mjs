// Looks up L2B-14699 directly -- its CF-#### display key and other basic
// details. Read-only.
//
// Usage: node check-l2b-14699.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'L2B-14699';

async function main() {
  const { rows } = await pool.query(`
    SELECT i.key, i.cf_key, i.summary, i.current_department, i.priority, i."createdAt",
           s.name AS status_name, u.email AS assignee_email, u."firstName", u."lastName"
    FROM issues i
    LEFT JOIN statuses s ON s.id = i."statusId"
    LEFT JOIN users u ON u.id = i."assigneeId"
    WHERE i.key = $1 OR i.cf_key = $1 LIMIT 1
  `, [KEY]);
  const issue = rows[0];
  if (!issue) { console.log(`${KEY} not found`); await pool.end(); return; }

  console.log(`=== ${KEY} ===`);
  console.log('Native key:', issue.key);
  console.log('CF display key:', issue.cf_key);
  console.log('Summary:', issue.summary);
  console.log('Department:', issue.current_department);
  console.log('Priority:', issue.priority);
  console.log('Status:', issue.status_name);
  console.log('Assignee:', issue.firstName ? `${issue.firstName} ${issue.lastName} (${issue.assignee_email})` : 'Unassigned');
  console.log('Created:', issue.createdAt);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
