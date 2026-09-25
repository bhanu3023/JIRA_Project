// backfill-sanitize-rich-text.mjs's dry run flagged 33,186/132,852 comments
// (~25%) as "needing cleanup" -- far too high to plausibly be real XSS
// payloads in a normal production system, which strongly suggests the
// sanitizer's allowed-tags/attributes list is too strict and is stripping
// LEGITIMATE formatting the rich-text editor produces (inline styles,
// specific classes, etc.), not just malicious content. This inspects a
// small sample of exactly what gets removed, aggregated by which
// tag/attribute was stripped, WITHOUT printing full comment bodies (could
// contain customer data) -- so the actual cause can be diagnosed before
// ever running --apply on 33k+ real rows.
//
// Read-only.
//
// Usage: node check-sanitize-diff-sample.mjs
import pg from 'pg';
import sanitizeHtml from 'sanitize-html';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const OPTIONS = {
  allowedTags: [
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'blockquote',
    'ul', 'ol', 'li', 'a', 'img', 'code', 'pre', 'span', 'div',
    'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel', 'class'],
    img: ['src', 'alt', 'width', 'height', 'style'],
    span: ['class', 'data-userid', 'data-mention', 'style'],
    div: ['class'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
    '*': ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowVulnerableTags: false,
};

// Extract every tag name and every "tag attr" pair present in a string,
// crude but good enough to diff which ones vanished after sanitizing.
function extractTagsAndAttrs(html) {
  const tags = new Set();
  const attrs = new Set();
  const tagRe = /<([a-zA-Z0-9]+)((?:\s+[a-zA-Z0-9:_-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*\/?>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[1].toLowerCase();
    tags.add(tag);
    const attrRe = /([a-zA-Z0-9:_-]+)(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?/g;
    let am;
    const attrsStr = m[2] || '';
    while ((am = attrRe.exec(attrsStr))) {
      attrs.add(`${tag}[${am[1].toLowerCase()}]`);
    }
  }
  return { tags, attrs };
}

async function main() {
  const { rows } = await pool.query(
    `SELECT id, body FROM comments WHERE body IS NOT NULL AND body != '' ORDER BY random() LIMIT 3000`
  );
  const removedTagCounts = new Map();
  const removedAttrCounts = new Map();
  let sampleChanged = 0;
  const genuinelySuspicious = [];

  for (const r of rows) {
    const cleaned = sanitizeHtml(r.body, OPTIONS);
    if (cleaned === r.body) continue;
    sampleChanged++;
    const before = extractTagsAndAttrs(r.body);
    const after = extractTagsAndAttrs(cleaned);
    for (const t of before.tags) if (!after.tags.has(t)) removedTagCounts.set(t, (removedTagCounts.get(t) || 0) + 1);
    for (const a of before.attrs) if (!after.attrs.has(a)) removedAttrCounts.set(a, (removedAttrCounts.get(a) || 0) + 1);
    // Flag anything that looks like a genuine attack for manual review
    if (/onerror|onload|onclick|<script|javascript:/i.test(r.body)) {
      genuinelySuspicious.push(r.id);
    }
  }

  console.log(`Sample: ${rows.length} comments, ${sampleChanged} changed by the sanitizer (${(sampleChanged/rows.length*100).toFixed(1)}%)`);
  console.log('\nTop removed tags (count = how many sampled comments lost this tag):');
  console.log([...removedTagCounts.entries()].sort((a,b) => b[1]-a[1]).slice(0, 20));
  console.log('\nTop removed tag[attribute] combos:');
  console.log([...removedAttrCounts.entries()].sort((a,b) => b[1]-a[1]).slice(0, 30));
  console.log(`\nComments in this sample containing an actual attack signature (onerror/onload/onclick/<script/javascript:): ${genuinelySuspicious.length}`);
  if (genuinelySuspicious.length) console.log('Comment IDs (for manual review):', genuinelySuspicious.slice(0, 20));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
