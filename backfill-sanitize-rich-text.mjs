// Comment bodies and issue description/rootCause/fixDescription are now
// sanitized on every NEW save (see sanitizeRichText in jira-pg-api.ts), but
// that only protects writes going forward -- anything already stored before
// that fix shipped is untouched, and would still execute as real HTML/JS
// today if it contains a malicious payload (e.g. an <img onerror=...> that
// reads localStorage and exfiltrates a still-active pre-cookie-migration
// session token to an attacker's server). This is the one-time cleanup:
// re-run the EXACT SAME sanitizer over every existing row and rewrite only
// the ones that actually change.
//
// Uses the real sanitize-html package from the app's own node_modules (run
// this via `docker exec jira_app node ...` so it resolves correctly) with
// options mirroring RICH_TEXT_SANITIZE_OPTIONS in jira-pg-api.ts exactly.
//
// Dry-run by default; pass --apply to write. Never prints full HTML bodies
// (could contain customer data) -- only counts and a short diff length per
// row in dry-run mode.
//
// Usage: node backfill-sanitize-rich-text.mjs [--apply]
import pg from 'pg';
import sanitizeHtml from 'sanitize-html';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

// Kept byte-for-byte in sync with RICH_TEXT_SANITIZE_OPTIONS in
// src/lib/jira-pg-api.ts -- see that file's comment for why data-*/style/
// title are broadly allowed (none can execute code; they're what a real
// sample of this app's own content turned out to actually need).
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
function sanitize(html) {
  if (!html) return html;
  return sanitizeHtml(html, OPTIONS);
}

async function processTable(label, table, idCol, col, whereExtra = '') {
  const { rows } = await pool.query(`SELECT ${idCol} AS id, ${col} AS val FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != '' ${whereExtra}`);
  let changed = 0;
  for (const r of rows) {
    const cleaned = sanitize(r.val);
    if (cleaned !== r.val) {
      changed++;
      if (APPLY) {
        await pool.query(`UPDATE ${table} SET ${col} = $1 WHERE ${idCol} = $2`, [cleaned, r.id]);
      }
    }
  }
  console.log(`${label}: ${rows.length} rows checked, ${changed} needed cleanup${APPLY ? ' (applied)' : ' (dry run)'}`);
}

async function main() {
  await processTable('comments.body', 'comments', 'id', 'body');
  await processTable('issues.description', 'issues', 'id', 'description');
  await processTable('issues.rootCause', 'issues', 'id', '"rootCause"');
  await processTable('issues.fixDescription', 'issues', 'id', '"fixDescription"');
  if (!APPLY) console.log('\nDry run only. Re-run with --apply to write the cleaned versions.');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
