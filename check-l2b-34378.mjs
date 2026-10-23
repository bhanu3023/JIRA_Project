import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const { rows } = await pool.query(
    `SELECT key, summary, "createdAt", emailthreadid, current_department, "spaceId",
            (SELECT key FROM spaces WHERE id = issues."spaceId") AS space_key
     FROM issues WHERE key = 'L2B-34378'`
  );
  console.log('L2B-34378:', rows[0]);

  const { rows: cf } = await pool.query(
    `SELECT key, summary, "createdAt", emailthreadid, current_department FROM issues WHERE key = 'CF-34380'`
  );
  console.log('\nCF-34380:', cf[0]);

  const { rows: comments } = await pool.query(
    `SELECT id, "authorName", body, "createdAt" FROM comments WHERE "issueId" = (SELECT id FROM issues WHERE key = 'L2B-34378') ORDER BY "createdAt" DESC LIMIT 5`
  );
  console.log('\nRecent comments on L2B-34378:', comments);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
