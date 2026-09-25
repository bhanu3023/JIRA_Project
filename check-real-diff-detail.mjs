// check-cosmetic-only-diffs.mjs found 186/3000 (6.2%) comments where the
// sanitizer changes the actual VISIBLE TEXT, not just markup formatting --
// need to see what specifically differs before trusting this against real
// data. Common false-positive causes to rule out: HTML entity
// re-encoding (&nbsp; etc), and Microsoft Office's conditional comments
// (<!--[if gte mso 9]>...<![endif]-->) which a naive tag-stripping regex
// can mis-parse (stopping at the first internal '>') while a real HTML
// parser (what sanitize-html and the browser both use) correctly removes
// the whole block -- that would show as "lost text" in a crude diff tool
// without being a real loss of anything a person ever saw rendered.
//
// Shows a short, centered snippet (default 120 chars) around the first
// actual differing point for a handful of real examples -- not the full
// comment body, but calibrated to give enough context to judge whether
// it's a real problem.
//
// Read-only.
//
// Usage: node check-real-diff-detail.mjs
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

function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
           .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function plainText(html) {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}
function firstDiffIndex(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return i;
  return len;
}
function snippet(s, center, radius = 60) {
  const start = Math.max(0, center - radius);
  const end = Math.min(s.length, center + radius);
  return (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : '');
}

async function main() {
  const { rows } = await pool.query(
    `SELECT id, body FROM comments WHERE body IS NOT NULL AND body != '' ORDER BY random() LIMIT 3000`
  );
  let shown = 0;
  for (const r of rows) {
    if (shown >= 15) break;
    const cleaned = sanitizeHtml(r.body, OPTIONS);
    if (cleaned === r.body) continue;
    const beforeText = plainText(r.body);
    const afterText = plainText(cleaned);
    if (beforeText === afterText) continue; // cosmetic only, already covered separately
    const idx = firstDiffIndex(beforeText, afterText);
    console.log(`\n[${r.id}] first diff at char ${idx}`);
    console.log(`  BEFORE: ${snippet(beforeText, idx)}`);
    console.log(`  AFTER:  ${snippet(afterText, idx)}`);
    shown++;
  }
  console.log(`\nShown ${shown} real-difference examples.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
