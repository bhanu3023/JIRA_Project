/**
 * fix-migration-description-headings.mjs
 *
 * Retrofits lock protection onto the numbered template headings ("1. Issue
 * Reported" ... "9. Server Url") that already exist as plain, freely
 * editable text in Migration board (L1BOAR-*) ticket descriptions.
 *
 * New Migration tickets already get this template auto-inserted with
 * protection built in (see src/lib/migration-description-template.ts +
 * CreateIssueModal.tsx), and RichTextEditor.tsx now refuses to let any
 * element carrying `data-locked-heading="true"` be removed or edited, by
 * anyone, ever. This script marks up EXISTING tickets' already-typed
 * headings the same way, using each ticket's own current wording (it does
 * NOT rewrite "6. Postman Result" to "6. Postman Results" etc. -- only
 * locks whatever text is already there), so this is purely additive:
 * nothing about what the ticket says changes, only whether it can still be
 * edited afterward.
 *
 * Migration tickets store description in one of two shapes depending on
 * how they were created:
 *   (a) Real HTML (typed directly in the app's rich text editor) -- each
 *       line is its own <div>/<p>/<h1-6> block, headings are usually
 *       wrapped in <b>/<strong>.
 *   (b) Plain text with \n line breaks (tickets migrated straight from
 *       Jira via migrate-cfits.js, which stores extractText() output with
 *       no HTML at all).
 * Both are handled: (a) locks the matching block in place; (b) rebuilds
 * the whole description as one <div> per line (a real fix in itself --
 * plain-text-with-\n was never rendering as separate lines in the HTML
 * editor to begin with) with heading lines locked.
 *
 * SAFETY: A ticket is only touched if it has at least MIN_HEADINGS
 * distinct numbered lines (1-9) in strictly increasing order with no
 * repeats -- anything more ambiguous than that (stray "1. " in unrelated
 * text, out-of-order numbers, etc.) is left alone and reported separately
 * for manual review rather than guessed at. Already-locked tickets
 * (data-locked-heading already present) are skipped as done.
 *
 * SAFE BY DEFAULT: dry run unless DRY_RUN=false is passed explicitly.
 *
 * Env vars:
 *   DATABASE_URL - optional, defaults to the local dev DB
 *   DRY_RUN      - default 'true'; pass 'false' to actually write
 *
 * Run: node fix-migration-description-headings.mjs
 * Apply for real: DRY_RUN=false node fix-migration-description-headings.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const DRY_RUN = process.env.DRY_RUN !== 'false';
const MIN_HEADINGS = 5;
const HEADING_LINE_RE = /^([1-9])\.\s*(.+)$/;

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stripTags = (html) => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
const lockedHeadingHtml = (n, label) =>
  `<div data-locked-heading="true" contenteditable="false" draggable="false">${n}. ${escapeHtml(label)}</div>`;

// Validates a sequence of detected heading numbers: enough of them, strictly
// increasing, no repeats. Anything else is too ambiguous to touch safely.
function isPlausibleSequence(numbers) {
  if (numbers.length < MIN_HEADINGS) return false;
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] <= numbers[i - 1]) return false;
  }
  return new Set(numbers).size === numbers.length;
}

function fixHtmlDescription(html) {
  const blockRe = /<(div|p|h[1-6])(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  const blocks = [];
  let m;
  while ((m = blockRe.exec(html))) {
    const text = stripTags(m[3]);
    const hm = HEADING_LINE_RE.exec(text);
    blocks.push({ start: m.index, end: m.index + m[0].length, headingMatch: hm });
  }
  const headingBlocks = blocks.filter((b) => b.headingMatch);
  const numbers = headingBlocks.map((b) => Number(b.headingMatch[1]));
  if (!isPlausibleSequence(numbers)) return { changed: false, reason: `found ${headingBlocks.length} candidate heading line(s), not a plausible 1-9 sequence` };

  let result = html;
  for (const b of [...headingBlocks].reverse()) {
    const [, n, label] = b.headingMatch;
    result = result.slice(0, b.start) + lockedHeadingHtml(n, label.trim()) + result.slice(b.end);
  }
  return { changed: true, html: result };
}

function fixPlainTextDescription(text) {
  const lines = text.split('\n');
  const headingLines = [];
  lines.forEach((line, i) => {
    const hm = HEADING_LINE_RE.exec(line.trim());
    if (hm) headingLines.push({ i, hm });
  });
  const numbers = headingLines.map((h) => Number(h.hm[1]));
  if (!isPlausibleSequence(numbers)) return { changed: false, reason: `found ${headingLines.length} candidate heading line(s), not a plausible 1-9 sequence` };

  const headingByLine = new Map(headingLines.map((h) => [h.i, h.hm]));
  const html = lines
    .map((line, i) => {
      const hm = headingByLine.get(i);
      if (hm) return lockedHeadingHtml(hm[1], hm[2].trim());
      const trimmed = line.trim();
      return trimmed ? `<div>${escapeHtml(trimmed)}</div>` : '<div><br></div>';
    })
    .join('');
  return { changed: true, html };
}

async function main() {
  const { rows } = await pool.query(`SELECT id, key, description FROM issues WHERE key LIKE 'L1BOAR-%' AND description IS NOT NULL AND description != ''`);

  let alreadyLocked = 0;
  let fixed = 0;
  let needsReview = [];
  const sample = [];

  for (const row of rows) {
    if (row.description.includes('data-locked-heading')) { alreadyLocked++; continue; }

    const isHtml = /<[a-z][\s\S]*>/i.test(row.description);
    const result = isHtml ? fixHtmlDescription(row.description) : fixPlainTextDescription(row.description);

    if (!result.changed) {
      needsReview.push({ key: row.key, reason: result.reason });
      continue;
    }

    fixed++;
    if (sample.length < 10) sample.push({ key: row.key, shape: isHtml ? 'html' : 'plain-text' });

    if (!DRY_RUN) {
      await pool.query(`UPDATE issues SET description = $1 WHERE id = $2`, [result.html, row.id]);
    }
  }

  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Checked ${rows.length} Migration ticket(s) with a non-empty description.`);
  console.log(`${alreadyLocked} already locked (skipped, nothing to do).`);
  console.log(`${DRY_RUN ? '[DRY RUN] Would lock' : 'Locked'} headings in ${fixed} ticket(s).`);
  console.log(`${needsReview.length} ticket(s) need manual review (no plausible 1-9 heading sequence found):`);
  console.log(JSON.stringify(needsReview.slice(0, 30), null, 2));
  console.log('Sample of tickets fixed (first 10):');
  console.log(JSON.stringify(sample, null, 2));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
