// One-time data repair for comments/descriptions whose embedded-image
// upload got frozen mid-flight (see check-stuck-image-placeholders.mjs and
// the handleAddComment/handleSubmitReply fix in issues/[issueKey]/page.tsx
// that stops NEW ones from happening). Targets the placeholder markup
// RichTextEditor inserts (see insertImage / extractEmbeddedImages) --
// never touches plain text that merely mentions the word "uploading"
// (confirmed real case: CF-33897's comment literally says "(image
// uploading is taking time)" as the user's own words, no actual
// placeholder markup there at all, so this regex correctly leaves it
// alone -- see PLACEHOLDER_RE's own comment for why).
//
// Two outcomes per match:
//  - If a real <img>/data-rte-img-wrap already sits immediately after the
//    placeholder (confirmed for real on CF-34455 comment pg_j6ald0qds2: the
//    upload actually succeeded, but the old placeholder span was never
//    removed) -- just delete the orphaned placeholder, the real image stays.
//  - Otherwise the image never made it anywhere recoverable -- replace the
//    placeholder with a plain, clearly-labeled note instead of leaving
//    confusing "Uploading..." text frozen forever.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Was /<span\s+id="up-[a-z0-9]+"[^>]*>.../ -- matched ZERO rows for real,
// confirmed via check-placeholder-raw.mjs: the backend's save-time
// sanitizer strips the id attribute before storage (the live in-browser DOM
// has it, for document.getElementById to find while resolving the upload,
// but it never survives to the DB). Match on tag + text content instead --
// safe because nothing else in this app wraps literal "Uploading..." text in
// a <span>: a real file-upload placeholder resolves to an <a> tag on
// success, and CF-33897's "(image uploading is taking time)" mention
// (confirmed via the same raw dump) is plain text with <br/> separators, not
// inside a <span> at all, so this correctly leaves it untouched.
const PLACEHOLDER_RE = /<span[^>]*>Uploading[^<]*<\/span>/gi;
const FAILED_NOTE = '<span style="display:inline-block;padding:4px 8px;background:#fef2f2;border-radius:6px;color:#b91c1c;font-size:12px;">[Image upload did not complete — original image unavailable]</span>';

function repair(html) {
  if (!html || !PLACEHOLDER_RE.test(html)) return null;
  PLACEHOLDER_RE.lastIndex = 0;
  let removedAsDuplicate = 0, replacedAsFailed = 0;
  const next = html.replace(PLACEHOLDER_RE, (match, offset, full) => {
    const after = full.slice(offset + match.length, offset + match.length + 300);
    const hasRealImageRightAfter = /^\s*(&nbsp;)?\s*<(img|span[^>]*data-rte-img-wrap)/i.test(after);
    if (hasRealImageRightAfter) { removedAsDuplicate++; return ''; }
    replacedAsFailed++;
    return FAILED_NOTE;
  });
  return { next, removedAsDuplicate, replacedAsFailed };
}

async function main() {
  const { rows: comments } = await pool.query(
    `SELECT c.id, c."issueId", i.key, i.cf_key, c.body
     FROM comments c JOIN issues i ON i.id = c."issueId"
     WHERE c.body ILIKE '%Uploading pasted image%' OR c.body ILIKE '%Uploading "%'`
  );
  console.log(`Checking ${comments.length} comment(s)...`);
  for (const c of comments) {
    const r = repair(c.body);
    if (!r) continue;
    await pool.query(`UPDATE comments SET body = $1 WHERE id = $2`, [r.next, c.id]);
    console.log(`Fixed comment ${c.id} on ${c.cf_key || c.key}: removed ${r.removedAsDuplicate} duplicate placeholder(s), replaced ${r.replacedAsFailed} as failed.`);
  }

  const { rows: issues } = await pool.query(
    `SELECT id, key, cf_key, description FROM issues WHERE description ILIKE '%Uploading pasted image%' OR description ILIKE '%Uploading "%'`
  );
  console.log(`\nChecking ${issues.length} issue description(s)...`);
  for (const i of issues) {
    const r = repair(i.description);
    if (!r) continue;
    await pool.query(`UPDATE issues SET description = $1 WHERE id = $2`, [r.next, i.id]);
    console.log(`Fixed description on ${i.cf_key || i.key}: removed ${r.removedAsDuplicate} duplicate placeholder(s), replaced ${r.replacedAsFailed} as failed.`);
  }

  console.log('\nDone.');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
