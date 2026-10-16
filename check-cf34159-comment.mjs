// Read-only check of CF-34159's comments, specifically Kamal Basha's --
// the screenshot shows his name+timestamp rendering with no comment body
// text between it and the Reply/Edit/Delete row, suggesting the body
// itself is empty or not rendering, not that the comment is missing
// entirely.
//
// Usage: node check-cf34159-comment.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'CF-34159';

async function main() {
  const { rows: issueRows } = await pool.query(`SELECT id FROM issues WHERE key=$1 OR cf_key=$1 LIMIT 1`, [KEY]);
  const issue = issueRows[0];
  if (!issue) { console.log(`${KEY} not found`); await pool.end(); return; }

  const { rows } = await pool.query(`
    SELECT c.id, c."createdAt", c."authorId", u."firstName", u."lastName", c.body, LENGTH(c.body) AS body_len, c."isInternal"
    FROM comments c LEFT JOIN users u ON u.id = c."authorId"
    WHERE c."issueId" = $1 ORDER BY c."createdAt" DESC LIMIT 10
  `, [issue.id]);
  console.log(`Last 10 comments on ${KEY}:\n`);
  for (const r of rows) {
    console.log(`[${r.createdAt.toISOString()}] ${r.firstName} ${r.lastName} (internal=${r.isInternal}) body_len=${r.body_len}`);
    console.log(`  body: ${JSON.stringify(r.body)}`);
    console.log('');
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
