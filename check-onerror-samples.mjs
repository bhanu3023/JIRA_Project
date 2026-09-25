// 86/3000 sampled comments contain a real <img onerror=...> attribute --
// need to know whether these are genuine attack payloads or a benign
// "hide broken pasted-image" pattern common in Outlook/Teams-sourced HTML
// (the same sample also showed heavy Outlook/Teams paste-metadata
// attributes on the same comments, suggesting the latter). Prints ONLY the
// onerror attribute's own value (not the surrounding comment content, which
// could contain customer data) for a handful of real examples, truncated.
//
// Read-only.
//
// Usage: node check-onerror-samples.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT id, body FROM comments WHERE body ILIKE '%onerror%' LIMIT 5000`
  );
  console.log(`Comments containing "onerror" anywhere: ${rows.length}`);
  const seen = new Set();
  let shown = 0;
  for (const r of rows) {
    const re = /onerror\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let m;
    while ((m = re.exec(r.body)) && shown < 25) {
      const val = (m[1] ?? m[2] ?? '').slice(0, 200);
      if (seen.has(val)) continue;
      seen.add(val);
      console.log(`  [${r.id}] onerror="${val}"`);
      shown++;
    }
    if (shown >= 25) break;
  }
  console.log(`\nDistinct onerror values shown: ${seen.size}`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
