/**
 * backfill-migration-cfits-assignee-reporter.mjs
 *
 * Same idea as backfill-jira-assignee-reporter.mjs (Dev queue <- L2B/L3B),
 * but for Migration-queue tickets migrated from Jira project CFITS. Their
 * local key (L1BOAR-####) isn't the real Jira key -- that's stored
 * separately in issues.jira_source_key (CFITS-####) -- so looking them up
 * by local key the way the Dev-queue script does would 404 on every one.
 *
 * Fills in missing assignee/reporter from live Jira, for whichever field is
 * currently NULL. Deliberately additive only: never overwrites a ticket
 * that already has an assignee or reporter set (whether from the original
 * migration or a real reassignment done in-app since) -- only a
 * currently-empty field gets filled in.
 *
 * If the Jira assignee/reporter has no matching local user (by email), one
 * is created on the fly, same as the original migration scripts did.
 *
 * Required env vars (never hardcode these):
 *   JIRA_EMAIL, JIRA_TOKEN   - Jira Cloud auth
 *   DATABASE_URL             - optional, defaults to the local dev DB
 *   BACKFILL_LIMIT           - optional, cap how many issues to process (test runs)
 *   BACKFILL_CONCURRENCY     - optional, default 6
 *
 * Run: JIRA_EMAIL=... JIRA_TOKEN=... node backfill-migration-cfits-assignee-reporter.mjs
 */
import pg from 'pg';
import https from 'https';
import crypto from 'crypto';

const { Pool } = pg;
const rid = () => 'ar_' + crypto.randomBytes(12).toString('hex');

const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const JIRA_HOST = process.env.JIRA_HOST || 'cf2020.atlassian.net';
if (!JIRA_EMAIL || !JIRA_TOKEN) {
  console.error('Set JIRA_EMAIL and JIRA_TOKEN environment variables first.');
  process.exit(1);
}
const AUTH = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const LIMIT = process.env.BACKFILL_LIMIT ? parseInt(process.env.BACKFILL_LIMIT, 10) : Infinity;
const CONCURRENCY = process.env.BACKFILL_CONCURRENCY ? parseInt(process.env.BACKFILL_CONCURRENCY, 10) : 6;

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
          if (res.statusCode === 429) return reject({ retryable: true, retryAfter: parseInt(res.headers['retry-after'] || '5', 10) });
          if (res.statusCode >= 500) return reject({ retryable: true, retryAfter: 5 });
          if (res.statusCode === 404) return reject({ notFound: true });
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} for ${path}: ${data.slice(0, 300)}`));
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }
    ).on('error', (e) => reject({ retryable: true, retryAfter: 5, cause: e }));
  });
}

async function jiraGetWithRetry(path, attempt = 0) {
  try { return await jiraGet(path); }
  catch (e) {
    if (e?.notFound) throw e;
    if (e && e.retryable && attempt < 6) {
      await new Promise((r) => setTimeout(r, (e.retryAfter || 5) * 1000));
      return jiraGetWithRetry(path, attempt + 1);
    }
    throw e;
  }
}

const userCache = new Map(); // email -> local user id
async function resolveOrCreateUser(jiraUser) {
  if (!jiraUser) return null;
  // Jira app/bot accounts (e.g. "Automation for Jira") have no emailAddress
  // in the API response at all -- synthesize a stable placeholder email from
  // the account id instead of skipping, same fallback the other backfills use.
  const accountId = jiraUser.accountId || '';
  const email = (jiraUser.emailAddress || '').toLowerCase() || (accountId ? `jira_${accountId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)}@cloudfuze.com` : '');
  if (!email) return null;
  if (userCache.has(email)) return userCache.get(email);

  const existing = await pool.query('SELECT id FROM users WHERE LOWER(email)=$1 LIMIT 1', [email]);
  if (existing.rows[0]) {
    userCache.set(email, existing.rows[0].id);
    return existing.rows[0].id;
  }

  const displayName = jiraUser.displayName || email;
  const nameParts = displayName.trim().split(' ');
  const firstName = nameParts[0] || displayName;
  const lastName = nameParts.slice(1).join(' ');
  const newId = rid();
  try {
    await pool.query(
      `INSERT INTO users (id, email, "firstName", "lastName", "displayName", password, role, "isActive", "createdAt", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,'changeme123','agent',true,NOW(),NOW())`,
      [newId, email, firstName, lastName, displayName]
    );
    userCache.set(email, newId);
    return newId;
  } catch (e) {
    const row = await pool.query('SELECT id FROM users WHERE LOWER(email)=$1 LIMIT 1', [email]);
    if (row.rows[0]) { userCache.set(email, row.rows[0].id); return row.rows[0].id; }
    throw e;
  }
}

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

const stats = { processed: 0, assigneeFilled: 0, reporterFilled: 0, notFound: 0, errors: 0 };

async function backfillIssue(id, sourceKey, needsAssignee, needsReporter) {
  const wanted = needsAssignee && needsReporter ? 'assignee,reporter' : needsAssignee ? 'assignee' : 'reporter';
  let data;
  try {
    data = await jiraGetWithRetry(`/rest/api/3/issue/${sourceKey}?fields=${wanted}`);
  } catch (e) {
    if (e?.notFound) { stats.notFound++; return; }
    throw e;
  }

  const sets = [];
  const params = [];
  let idx = 1;

  if (needsAssignee && data.fields?.assignee) {
    const userId = await resolveOrCreateUser(data.fields.assignee);
    if (userId) { sets.push(`"assigneeId"=$${idx++}`); params.push(userId); stats.assigneeFilled++; }
  }
  if (needsReporter && data.fields?.reporter) {
    const userId = await resolveOrCreateUser(data.fields.reporter);
    if (userId) { sets.push(`"reporterId"=$${idx++}`); params.push(userId); stats.reporterFilled++; }
  }

  if (sets.length === 0) return; // Jira itself has no assignee/reporter for this ticket -- nothing to fill

  // Guard every SET with "still NULL" so this can never clobber a value that
  // changed (via a real in-app reassignment) between the SELECT that found
  // this ticket and this UPDATE actually running.
  const guardedSets = sets.map((s) => {
    const col = s.split('=')[0];
    return `${col} = CASE WHEN ${col} IS NULL THEN ${s.split('=')[1]} ELSE ${col} END`;
  });
  params.push(id);
  await pool.query(`UPDATE issues SET ${guardedSets.join(', ')} WHERE id=$${idx}`, params);
}

async function main() {
  const res = await pool.query(
    `SELECT id, key, jira_source_key, "assigneeId", "reporterId" FROM issues
     WHERE LOWER(current_department)='migration' AND jira_source_key LIKE 'CFITS-%'
       AND ("assigneeId" IS NULL OR "reporterId" IS NULL)
     ORDER BY key`
  );
  const targets = res.rows.slice(0, LIMIT === Infinity ? res.rows.length : LIMIT);
  console.log(`Found ${res.rows.length} Migration/CFITS tickets missing assignee and/or reporter; processing ${targets.length} this run with concurrency=${CONCURRENCY}.`);

  await runPool(targets, async (row) => {
    try {
      await backfillIssue(row.id, row.jira_source_key, row.assigneeId === null, row.reporterId === null);
      stats.processed++;
    } catch (e) {
      stats.errors++;
      console.error(`[ERROR] ${row.key} (${row.jira_source_key}):`, e?.message || e);
    }
    if (stats.processed % 25 === 0) {
      console.log(`progress: ${stats.processed}/${targets.length} | +assignee=${stats.assigneeFilled} +reporter=${stats.reporterFilled} notFound=${stats.notFound} errors=${stats.errors}`);
    }
  }, CONCURRENCY);

  console.log('\nDone.');
  console.log(stats);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
