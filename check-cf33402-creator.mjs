// Read-only check: pull the full snapshot stored for CF-33402 at deletion
// time, to see exactly who was recorded as its reporter/creator.
//
// Usage: node check-cf33402-creator.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'CF-33402';

async function main() {
  const { rows } = await pool.query(`SELECT data, deleted_by_name, deleted_at FROM deleted_issues WHERE key = $1 OR cf_key = $1`, [KEY]);
  if (!rows.length) { console.log('Not found'); await pool.end(); return; }
  const { data, deleted_by_name, deleted_at } = rows[0];
  console.log('Deleted by:', deleted_by_name, 'at', deleted_at);
  console.log('\nFull stored snapshot keys:', Object.keys(data));
  const issue = data.issue || {};
  console.log('\nissue keys:', Object.keys(issue));
  console.log('reporterId:', issue.reporterId);
  console.log('reporter:', issue.reporter);
  console.log('createdAt:', issue.createdAt);
  console.log('assigneeId:', issue.assigneeId);
  console.log('assignee:', issue.assignee);

  const reporterId = issue.reporterId || issue.reporter?.id;
  if (reporterId) {
    const { rows: u } = await pool.query(`SELECT "firstName", "lastName", email FROM users WHERE id = $1`, [reporterId]);
    console.log('\nResolved reporter from users table:', u[0]);
  }

  if (Array.isArray(data.history) && data.history.length) {
    console.log('\nFirst few history entries:');
    for (const h of data.history.slice(0, 5)) console.log(' ', h);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
