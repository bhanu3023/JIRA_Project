/**
 * backfill-qa-history-comments.mjs
 *
 * Same script as backfill-jira-history-comments.mjs, targeting the QA
 * board instead of L2B/L3B. QA never got this backfill at all: local
 * issue_history and comments tables both have zero rows for every QA-*
 * ticket today (confirmed via inspect-qa-board.mjs), even though some
 * older sync scripts assumed history/comments syncing already covered it.
 *
 * Fetches full comments + changelog history from live Jira for every
 * QA-* ticket already migrated into this app, and inserts whatever is
 * missing.
 *
 * Safe to re-run: dedupes comments by (authorEmail, createdAt) and history
 * entries by (field, oldValue, newValue, createdAt) against what's already
 * in the DB, so a second run only fills in whatever a first run missed
 * (network errors, rate limits, etc.) instead of duplicating anything.
 *
 * Required env vars (never hardcode these):
 *   JIRA_EMAIL       - Jira account email
 *   JIRA_TOKEN        - Jira API token
 *   DATABASE_URL      - optional, defaults to the local dev DB
 *   BACKFILL_LIMIT    - optional, cap how many issues to process this run (for test runs)
 *
 * Run: JIRA_EMAIL=... JIRA_TOKEN=... node backfill-qa-history-comments.mjs
 */
import pg from 'pg';
import https from 'https';
import crypto from 'crypto';

const { Pool } = pg;
const rid = () => 'bf_' + crypto.randomBytes(12).toString('hex');

const JIRA_EMAIL = (process.env.JIRA_EMAIL || '').trim();
const JIRA_TOKEN = (process.env.JIRA_TOKEN || '').trim();
const JIRA_HOST = (process.env.JIRA_HOST || 'cf2020.atlassian.net').trim();
if (!JIRA_EMAIL || !JIRA_TOKEN) {
  console.error('Set JIRA_EMAIL and JIRA_TOKEN environment variables first.');
  process.exit(1);
}
const AUTH = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const LIMIT = process.env.BACKFILL_LIMIT ? parseInt(process.env.BACKFILL_LIMIT, 10) : Infinity;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

function jiraGet(path) {
  return new Promise((resolve, reject) => {
    https.get(
      { hostname: JIRA_HOST, path, headers: { Authorization: `Basic ${AUTH}`, Accept: 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode === 429) {
            return reject({ retryable: true, retryAfter: parseInt(res.headers['retry-after'] || '5', 10) });
          }
          if (res.statusCode >= 500) {
            return reject({ retryable: true, retryAfter: 5 });
          }
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode} for ${path}: ${data.slice(0, 300)}`));
          }
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }
    ).on('error', (e) => reject({ retryable: true, retryAfter: 5, cause: e }));
  });
}

async function jiraGetWithRetry(path, attempt = 0) {
  try {
    return await jiraGet(path);
  } catch (e) {
    if (e && e.retryable && attempt < 6) {
      await new Promise((r) => setTimeout(r, (e.retryAfter || 5) * 1000));
      return jiraGetWithRetry(path, attempt + 1);
    }
    throw e;
  }
}

// ADF -> plain text (same extraction approach as the original migration scripts)
function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) return node.content.map(extractText).join(node.type === 'paragraph' ? '' : '\n');
  return '';
}

const userCache = new Map();
async function resolveUserIdByEmail(email) {
  if (!email) return null;
  const key = email.toLowerCase();
  if (userCache.has(key)) return userCache.get(key);
  const r = await pool.query('SELECT id FROM users WHERE LOWER(email)=$1 LIMIT 1', [key]);
  const val = r.rows[0]?.id || null;
  userCache.set(key, val);
  return val;
}

async function fetchAllComments(key) {
  let all = [];
  let startAt = 0;
  for (;;) {
    const page = await jiraGetWithRetry(`/rest/api/3/issue/${key}/comment?startAt=${startAt}&maxResults=100`);
    const batch = page.comments || [];
    all = all.concat(batch);
    startAt += batch.length;
    if (batch.length === 0 || startAt >= (page.total || all.length)) break;
  }
  return all;
}

async function fetchAllChangelog(key) {
  let all = [];
  let startAt = 0;
  for (;;) {
    const page = await jiraGetWithRetry(`/rest/api/3/issue/${key}/changelog?startAt=${startAt}&maxResults=100`);
    const batch = page.values || [];
    all = all.concat(batch);
    startAt += batch.length;
    if (batch.length === 0 || startAt >= (page.total || all.length)) break;
  }
  return all;
}

const stats = { processed: 0, skipped: 0, commentsAdded: 0, historyAdded: 0, errors: 0 };

async function backfillIssue(issueId, key) {
  const [comments, histories] = await Promise.all([fetchAllComments(key), fetchAllChangelog(key)]);

  const existingComments = await pool.query(
    'SELECT "authorEmail", "createdAt" FROM comments WHERE "issueId"=$1',
    [issueId]
  );
  const existingCommentKeys = new Set(
    existingComments.rows.map((r) => `${(r.authorEmail || '').toLowerCase()}|${new Date(r.createdAt).getTime()}`)
  );

  for (const c of comments) {
    const email = (c.author?.emailAddress || '').toLowerCase();
    const createdDate = new Date(c.created);
    const updatedDate = c.updated ? new Date(c.updated) : createdDate;
    const dedupKey = `${email}|${createdDate.getTime()}`;
    if (existingCommentKeys.has(dedupKey)) continue;
    const authorId = await resolveUserIdByEmail(email);
    const body = extractText(c.body);
    await pool.query(
      `INSERT INTO comments (id, "issueId", body, "authorId", "authorName", "authorEmail", "createdAt", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [rid(), issueId, body, authorId, c.author?.displayName || 'Unknown', email || null, createdDate, updatedDate]
    );
    existingCommentKeys.add(dedupKey);
    stats.commentsAdded++;
  }

  const existingHistory = await pool.query(
    'SELECT field, "oldValue", "newValue", "createdAt" FROM issue_history WHERE "issueId"=$1',
    [issueId]
  );
  const existingHistoryKeys = new Set(
    existingHistory.rows.map(
      (r) => `${r.field}|${r.oldValue ?? ''}|${r.newValue ?? ''}|${new Date(r.createdAt).getTime()}`
    )
  );

  for (const h of histories) {
    const createdDate = new Date(h.created);
    for (const item of h.items || []) {
      const field = item.field || item.fieldId || 'field';
      const oldValue = item.fromString ?? (item.from != null ? String(item.from) : null);
      const newValue = item.toString ?? (item.to != null ? String(item.to) : null);
      const dedupKey = `${field}|${oldValue ?? ''}|${newValue ?? ''}|${createdDate.getTime()}`;
      if (existingHistoryKeys.has(dedupKey)) continue;
      await pool.query(
        `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [rid(), issueId, field, oldValue, newValue, h.author?.displayName || 'Unknown', (h.author?.emailAddress || '').toLowerCase() || null, createdDate]
      );
      existingHistoryKeys.add(dedupKey);
      stats.historyAdded++;
    }
  }
}

// Each ticket is independent (its own issueId, its own dedup checks scoped to
// that issue) so running several concurrently is safe.
const CONCURRENCY = process.env.BACKFILL_CONCURRENCY ? parseInt(process.env.BACKFILL_CONCURRENCY, 10) : 6;

async function runPool(items, worker, concurrency) {
  let nextIndex = 0;
  async function runOne() {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runOne));
}

async function main() {
  const res = await pool.query(`SELECT id, key FROM issues WHERE key LIKE 'QA-%' ORDER BY key`);
  const targets = res.rows.slice(0, LIMIT === Infinity ? res.rows.length : LIMIT);
  console.log(`Found ${res.rows.length} QA tickets; processing ${targets.length} this run with concurrency=${CONCURRENCY}.`);

  await runPool(targets, async ({ id, key }) => {
    try {
      await backfillIssue(id, key);
      stats.processed++;
    } catch (e) {
      stats.errors++;
      console.error(`[ERROR] ${key}:`, e?.message || e);
    }
    if (stats.processed % 25 === 0) {
      console.log(`progress: ${stats.processed}/${targets.length} | +comments=${stats.commentsAdded} +history=${stats.historyAdded} errors=${stats.errors}`);
    }
  }, CONCURRENCY);

  console.log('\nDone.');
  console.log(stats);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
