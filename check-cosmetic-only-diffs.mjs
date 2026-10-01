// After the allowlist fix, check-sanitize-diff-sample.mjs still shows 742/
// 3000 comments (24.7%) as "changed", but "Top removed tags" is now empty
// and only single-digit attribute counts remain -- suggesting most of the
// remaining diff is just sanitize-html's own re-serialization (self-closing
// tags, attribute quoting/ordering, whitespace) rather than any actual
// content loss. Confirms that hypothesis directly: for each changed
// comment, strips ALL tags/attributes from both the original and the
// cleaned version (reducing each to plain text) and compares THAT -- if the
// plain-text content is identical, the diff was purely cosmetic markup
// re-serialization, not lost content.
//
// Read-only. Never prints actual comment content.
//
// Usage: node check-cosmetic-only-diffs.mjs
import pg from 'pg';
import sanitizeHtml from 'sanitize-html';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const OPTIONS = {
  allowedTags: [
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'blockquote',
    'ul', 'ol', 'li', 'a', 'img', 'code', 'pre', 'span', 'div',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr',
    'details', 'summary', 'sub', 'sup', 'mark',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel', 'class', 'title', 'style', 'data-*'],
    img: ['src', 'alt', 'width', 'height', 'style', 'title', 'loading', 'data-*'],
    span: ['class', 'style', 'title', 'contenteditable', 'data-*'],
    div: ['class', 'style', 'contenteditable', 'data-*'],
    p: ['class', 'style', 'data-*'],
    blockquote: ['class', 'style', 'data-*'],
    ul: ['class', 'style', 'data-*'],
    ol: ['class', 'style', 'data-*'],
    li: ['class', 'style', 'data-*'],
    table: ['class', 'style', 'data-*'],
    thead: ['class', 'style', 'data-*'],
    tbody: ['class', 'style', 'data-*'],
    tr: ['class', 'style', 'data-*'],
    td: ['colspan', 'rowspan', 'class', 'style', 'data-*'],
    th: ['colspan', 'rowspan', 'class', 'style', 'data-*'],
    '*': ['class', 'data-*'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowVulnerableTags: false,
};

function plainText(html) {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function main() {
  const { rows } = await pool.query(
    `SELECT id, body FROM comments WHERE body IS NOT NULL AND body != '' ORDER BY random() LIMIT 3000`
  );
  let changed = 0, cosmeticOnly = 0, realContentLoss = 0;
  const realContentLossIds = [];
  for (const r of rows) {
    const cleaned = sanitizeHtml(r.body, OPTIONS);
    if (cleaned === r.body) continue;
    changed++;
    if (plainText(cleaned) === plainText(r.body)) cosmeticOnly++;
    else { realContentLoss++; realContentLossIds.push(r.id); }
  }
  console.log(`Sample: ${rows.length}, changed: ${changed}`);
  console.log(`  Cosmetic only (same visible text after stripping all tags): ${cosmeticOnly}`);
  console.log(`  Real content/text difference: ${realContentLoss}`);
  if (realContentLossIds.length) console.log('  IDs with real text differences (for manual review):', realContentLossIds.slice(0, 20));
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
