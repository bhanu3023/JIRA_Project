// Deletes all but the most recent comment on L2B-34378 (displayed as
// CF-34380) -- cleans up repeated test-reply spam from debugging the
// signature-stripping fix, per explicit request.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const { rows: issue } = await pool.query(`SELECT id FROM issues WHERE key = 'L2B-34378'`);
  const issueId = issue[0]?.id;
  if (!issueId) { console.error('Issue not found'); process.exit(1); }

  const { rows: comments } = await pool.query(
    `SELECT id, body, "createdAt" FROM comments WHERE "issueId" = $1 ORDER BY "createdAt" DESC`,
    [issueId]
  );
  console.log(`${comments.length} comments found.`);
  if (comments.length <= 1) { console.log('Nothing to clean up.'); await pool.end(); return; }

  const [keep, ...toDelete] = comments;
  console.log('Keeping:', keep.id, keep.createdAt);
  for (const c of toDelete) {
    await pool.query(`DELETE FROM comments WHERE id = $1`, [c.id]);
    console.log('Deleted:', c.id, c.createdAt);
  }
  console.log(`Done. Kept 1, deleted ${toDelete.length}.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
