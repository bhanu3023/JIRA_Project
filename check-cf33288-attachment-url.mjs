// The next.config.js fix (commit bbeb6d5) only relaxes X-Frame-Options for
// paths under /uploads/(.*) -- if this specific attachment's stored URL is
// actually served via a DIFFERENT path (e.g. /api/uploads/... instead of
// /uploads/...), that fix wouldn't cover it at all, explaining why the
// "refused to connect" framing error persists even after deploying it.
// Checks the real stored URL for CF-33288's "Cloudfuze CU Agreement fully
// executed.pdf" attachment.
//
// Read-only.
//
// Usage: node check-cf33288-attachment-url.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: issueRows } = await pool.query(`SELECT id FROM issues WHERE cf_key = 'CF-33288' OR key = 'CF-33288'`);
  if (!issueRows.length) { console.log('CF-33288 not found'); await pool.end(); return; }
  const issueId = issueRows[0].id;

  const { rows } = await pool.query(
    `SELECT id, "originalName", url, "mimeType" FROM attachments WHERE "issueId" = $1`,
    [issueId]
  ).catch(async (e) => {
    console.log(`attachments table query failed: ${e.message} -- trying alternate column names`);
    return pool.query(`SELECT * FROM attachments WHERE "issueId" = $1`, [issueId]);
  });
  console.log(`Attachments for CF-33288: ${rows.length}`);
  for (const r of rows) console.log(JSON.stringify(r, null, 2));

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
