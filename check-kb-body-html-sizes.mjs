// Read-only: the KB Articles list endpoint runs `SELECT a.*` (which includes
// the full body_html column) for every article just to build a short plain-
// text excerpt (excerptOf truncates to 220 chars AFTER fetching). If
// body_html routinely carries large embedded content (pasted screenshots as
// base64 data: URIs), this wastes huge amounts of DB->Node transfer on every
// single list load. Check real sizes to confirm before fixing.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM kb_articles`);
  console.log('Total kb_articles rows:', countRows[0].count);

  const { rows } = await pool.query(`
    SELECT kind, status, LENGTH(body_html) AS len
    FROM kb_articles
  `);
  const total = rows.reduce((s, r) => s + (r.len || 0), 0);
  const max = Math.max(0, ...rows.map((r) => r.len || 0));
  const over100k = rows.filter((r) => (r.len || 0) > 100_000).length;
  const over1m = rows.filter((r) => (r.len || 0) > 1_000_000).length;
  console.log(`Total body_html bytes across all articles: ${(total/1024/1024).toFixed(2)} MB`);
  console.log(`Largest single article body_html: ${(max/1024/1024).toFixed(2)} MB`);
  console.log(`Articles with body_html > 100KB: ${over100k}`);
  console.log(`Articles with body_html > 1MB: ${over1m}`);

  // What a single "published kb" list load (LIMIT 500, most common view)
  // actually pulls across the wire from Postgres today.
  const { rows: listRows } = await pool.query(`
    SELECT LENGTH(body_html) AS len FROM kb_articles
    WHERE kind = 'kb' AND status = 'published'
    ORDER BY COALESCE(published_at, updated_at) DESC LIMIT 500
  `);
  const listTotal = listRows.reduce((s, r) => s + (r.len || 0), 0);
  console.log(`\nA single published-KB list load (LIMIT 500) currently pulls ${(listTotal/1024/1024).toFixed(2)} MB of body_html from Postgres, just to produce a 220-char excerpt per article.`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
