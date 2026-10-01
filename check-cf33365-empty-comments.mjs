// Two comments on CF-33365 (Guru M and Sanjana Nerella, both 25/9/26
// ~8:10-8:11 PM) render with NO visible body text in the UI. These are
// recent -- created AFTER the sanitizeRichText fix was deployed on comment
// save. Strong suspicion: the same "a raw un-escaped < in plain text gets
// parsed as a malformed tag and swallows the rest" bug found earlier while
// investigating the (abandoned) backfill script is now happening LIVE on
// every new comment save, silently emptying real content. Checking the
// actual stored comment.body for these two directly.
//
// Read-only. Prints a short length + first/last chars only, not full
// content (could be sensitive), unless body is empty (safe to say so).
//
// Usage: node check-cf33365-empty-comments.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: issueRows } = await pool.query(`SELECT id FROM issues WHERE cf_key = 'CF-33365' OR key = 'CF-33365'`);
  const issueId = issueRows[0]?.id;
  if (!issueId) { console.log('Issue not found'); await pool.end(); return; }

  const { rows } = await pool.query(
    `SELECT c.id, c."authorName", c."createdAt", c."updatedAt", c.body, LENGTH(c.body) AS body_len
     FROM comments c WHERE c."issueId" = $1 ORDER BY c."createdAt" DESC LIMIT 10`,
    [issueId]
  );
  for (const r of rows) {
    console.log(`\n[${r.id}] ${r.authorName}  created=${r.createdAt.toISOString()}  updated=${r.updatedAt?.toISOString()}`);
    console.log(`  body length: ${r.body_len}`);
    if (r.body_len === 0 || r.body === null) {
      console.log('  body is EMPTY/NULL');
    } else if (r.body_len < 500) {
      console.log(`  body (short, showing full): ${JSON.stringify(r.body)}`);
    } else {
      console.log(`  body (long, showing first 200 chars): ${JSON.stringify(r.body.slice(0, 200))}`);
    }
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
