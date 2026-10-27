// Read-only: the repair script's `id="up-..."` regex matched ZERO rows even
// though the text-based search found 4 comments + 6 descriptions -- meaning
// whatever sanitization runs on save likely stripped the `id` attribute
// before storage. Dumps a much wider window (400 chars before the
// "Uploading" text) around each hit so the ACTUAL surviving markup/attributes
// can be seen and the repair regex corrected to match what's really there.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const { rows } = await pool.query(
    `SELECT c.id, i.cf_key, i.key, c.body
     FROM comments c JOIN issues i ON i.id = c."issueId"
     WHERE c.body ILIKE '%Uploading pasted image%' OR c.body ILIKE '%Uploading "%'
     ORDER BY c."createdAt" DESC LIMIT 2`
  );
  for (const r of rows) {
    const idx = r.body.search(/Uploading/i);
    console.log(`\n=== ${r.cf_key || r.key} | ${r.id} ===`);
    console.log(JSON.stringify(r.body.slice(Math.max(0, idx - 400), idx + 100)));
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
