// Read-only: find every comment (and issue description) across the whole
// DB that still contains a literal "Uploading pasted image" placeholder --
// meaning the comment was saved while an embedded-image upload was still in
// flight (or silently never completed), freezing the placeholder text
// permanently into the stored HTML instead of being replaced by the real
// image or removed. Confirmed for real on CF-34455 (two separate
// comments). Dumps the raw body around the placeholder for each hit, plus
// counts, so we know the true scope before deciding how to fix existing
// data.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: comments } = await pool.query(
    `SELECT c.id, c."issueId", i.key, i.cf_key, c."createdAt", c.body
     FROM comments c JOIN issues i ON i.id = c."issueId"
     WHERE c.body ILIKE '%Uploading pasted image%' OR c.body ILIKE '%Uploading "%'
     ORDER BY c."createdAt" DESC`
  );
  console.log(`Found ${comments.length} comment(s) with a stuck upload placeholder.\n`);
  for (const c of comments) {
    const idx = c.body.search(/Uploading/i);
    console.log(`--- ${c.cf_key || c.key} | comment ${c.id} | ${c.createdAt} ---`);
    console.log(c.body.slice(Math.max(0, idx - 80), idx + 200));
    console.log();
  }

  const { rows: issues } = await pool.query(
    `SELECT key, cf_key, "updatedAt" FROM issues WHERE description ILIKE '%Uploading pasted image%' OR description ILIKE '%Uploading "%'`
  );
  console.log(`\nFound ${issues.length} issue description(s) with a stuck upload placeholder:`);
  issues.forEach((i) => console.log(` - ${i.cf_key || i.key} (updated ${i.updatedAt})`));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
