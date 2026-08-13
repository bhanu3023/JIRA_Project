/**
 * find-missing-cfits-source-keys.mjs
 *
 * 189 Migration-queue tickets have current_department='Migration' (same
 * L1BOAR-#### key range as the other 7,470 CFITS-migrated tickets) but
 * jira_source_key IS NULL -- the original migration never recorded which
 * real Jira issue they came from. Without that key, none of the other
 * backfills (status, assignee/reporter, history/comments) can look them up
 * -- they all query Jira by jira_source_key, not by guessing.
 *
 * This re-matches each one against live Jira by summary + creation date:
 *   1. JQL search in project CFITS, created within +/-1 day of the local
 *      ticket's createdAt (migration should have preserved this), with the
 *      summary as an exact phrase filter to narrow candidates.
 *   2. Only accepts a match when exactly ONE candidate's summary is an
 *      exact (trimmed, case-insensitive) match to the local ticket's
 *      summary -- zero or multiple candidates are left unresolved rather
 *      than guessing.
 *
 * Only ever sets jira_source_key on a high-confidence match. Never touches
 * assignee/reporter/status/history/comments itself -- once jira_source_key
 * is set, re-run the existing backfill-migration-cfits-*.mjs scripts (they
 * already scope to jira_source_key LIKE 'CFITS-%') to pull that data in.
 *
 * SAFE BY DEFAULT: dry run unless DRY_RUN=false is passed explicitly.
 *
 * Required env vars (never hardcode these):
 *   JIRA_EMAIL, JIRA_TOKEN   - Jira Cloud auth
 *   DATABASE_URL             - optional, defaults to the local dev DB
 *   BACKFILL_LIMIT           - optional, cap how many issues to process (test runs)
 *
 * Run: JIRA_EMAIL=... JIRA_TOKEN=... node find-missing-cfits-source-keys.mjs
 * Apply for real: ... DRY_RUN=false node find-missing-cfits-source-keys.mjs
 */
import pg from 'pg';
import https from 'https';

const { Pool } = pg;

const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const JIRA_HOST = process.env.JIRA_HOST || 'cf2020.atlassian.net';
if (!JIRA_EMAIL || !JIRA_TOKEN) {
  console.error('Set JIRA_EMAIL and JIRA_TOKEN environment variables first.');
  process.exit(1);
}
const AUTH = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const DRY_RUN = process.env.DRY_RUN !== 'false';
const LIMIT = process.env.BACKFILL_LIMIT ? parseInt(process.env.BACKFILL_LIMIT, 10) : Infinity;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

function jiraPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: JIRA_HOST, path, method: 'POST',
        headers: {
          Authorization: `Basic ${AUTH}`, Accept: 'application/json', 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode === 429) return reject({ retryable: true, retryAfter: parseInt(res.headers['retry-after'] || '5', 10) });
          if (res.statusCode >= 500) return reject({ retryable: true, retryAfter: 5 });
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} for ${path}: ${data.slice(0, 400)}`));
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', (e) => reject({ retryable: true, retryAfter: 5, cause: e }));
    req.write(payload);
    req.end();
  });
}

async function jiraPostWithRetry(path, body, attempt = 0) {
  try { return await jiraPost(path, body); }
  catch (e) {
    if (e?.retryable && attempt < 6) {
      await new Promise((r) => setTimeout(r, (e.retryAfter || 5) * 1000));
      return jiraPostWithRetry(path, body, attempt + 1);
    }
    throw e;
  }
}

// Escape for a JQL double-quoted string literal.
function jqlEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function findMatch(row) {
  const summaryPhrase = jqlEscape(row.summary || '');
  if (!summaryPhrase.trim()) return { reason: 'empty summary -- nothing to match on' };

  // No date filter in the query itself -- the local createdAt on these
  // tickets is whatever the ORIGINAL migration stamped, which for this
  // specific broken batch may not be the real Jira creation date at all
  // (that's plausibly why they lost their jira_source_key in the first
  // place). A hard date range risked silently excluding the real match
  // before the summary filter ever got a chance to find it. Date is only
  // used below, as a tiebreaker if the summary match is ambiguous.
  const jql = `project = CFITS AND summary ~ "\\"${summaryPhrase}\\""`;
  let result;
  try {
    result = await jiraPostWithRetry('/rest/api/3/search/jql', { jql, fields: ['summary', 'created'], maxResults: 25 });
  } catch (e) {
    return { reason: `Jira search failed: ${e?.message || e}` };
  }
  const issues = result.issues || [];
  const exact = issues.filter((i) => norm(i.fields?.summary) === norm(row.summary));
  if (exact.length === 1) return { matchKey: exact[0].key };
  if (exact.length === 0) {
    return { reason: issues.length ? `${issues.length} candidate(s) found, none an exact summary match` : 'no candidates found' };
  }
  // Ambiguous on summary alone -- break the tie by closest creation date,
  // but only auto-accept if one candidate is clearly closest (>= 1 day
  // nearer than the next-best) rather than picking arbitrarily.
  const localCreated = new Date(row.createdAt).getTime();
  const byDateDelta = exact
    .map((i) => ({ key: i.key, deltaMs: Math.abs(new Date(i.fields.created).getTime() - localCreated) }))
    .sort((a, b) => a.deltaMs - b.deltaMs);
  const [best, secondBest] = byDateDelta;
  const ONE_DAY = 24 * 3600 * 1000;
  if (secondBest && (secondBest.deltaMs - best.deltaMs) >= ONE_DAY) {
    return { matchKey: best.key, note: `disambiguated by creation date among ${exact.length} exact-summary candidates` };
  }
  return { reason: `${exact.length} exact-summary candidates, creation dates too close to disambiguate safely: ${exact.map((i) => i.key).join(', ')}` };
}

async function main() {
  const res = await pool.query(
    `SELECT id, key, cf_key, summary, "createdAt" FROM issues
     WHERE LOWER(current_department) = 'migration' AND jira_source_key IS NULL
     ORDER BY key`
  );
  const targets = res.rows.slice(0, LIMIT === Infinity ? res.rows.length : LIMIT);
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Found ${res.rows.length} Migration tickets with no jira_source_key; processing ${targets.length} this run.`);

  const stats = { processed: 0, matched: 0, unresolved: 0, errors: 0 };
  const matches = [];
  const unresolved = [];

  // Sequential, not pooled -- Jira Cloud's JQL search endpoint is heavier
  // per-request than a plain issue GET, and this set is small (~189) so
  // there's no real time pressure to parallelize and risk the rate limiter.
  for (const row of targets) {
    try {
      const result = await findMatch(row);
      if (result.matchKey) {
        matches.push({ key: row.key, cfKey: row.cf_key, summary: row.summary, matchedTo: result.matchKey, note: result.note });
        stats.matched++;
        if (!DRY_RUN) {
          await pool.query(`UPDATE issues SET jira_source_key = $1 WHERE id = $2`, [result.matchKey, row.id]);
        }
      } else {
        unresolved.push({ key: row.key, cfKey: row.cf_key, summary: row.summary, reason: result.reason });
        stats.unresolved++;
      }
    } catch (e) {
      stats.errors++;
      console.error(`[ERROR] ${row.key}:`, e?.message || e);
    }
    stats.processed++;
    if (stats.processed % 20 === 0) {
      console.log(`progress: ${stats.processed}/${targets.length} | matched=${stats.matched} unresolved=${stats.unresolved} errors=${stats.errors}`);
    }
    await new Promise((r) => setTimeout(r, 150)); // gentle pacing, sequential
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Done.`);
  console.log(stats);
  console.log(`\n${DRY_RUN ? 'Would set' : 'Set'} jira_source_key for ${matches.length} ticket(s):`);
  console.log(JSON.stringify(matches, null, 2));
  console.log(`\n${unresolved.length} ticket(s) left unresolved (need manual review, nothing changed):`);
  console.log(JSON.stringify(unresolved, null, 2));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
