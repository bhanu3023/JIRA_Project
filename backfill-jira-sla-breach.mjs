/**
 * backfill-jira-sla-breach.mjs
 *
 * Imports the historical SLA-breach flag + due/start time from Jira for
 * every L2B-* and L3B-* ticket into new raw columns (jira_sla_breached,
 * jira_sla_due_at, jira_sla_start_at). This app's own SLA clock is scoped to
 * time spent in ITS departments and always reports "not breached" once a
 * ticket is resolved -- a ticket that was already breached in Jira before
 * migration would otherwise show "No" here forever, with no way to tell.
 *
 * Jira fields used (found by inspecting a real ticket's ?expand=names):
 *   customfield_10917  "SLA Breached"    -- select field, {value: "Yes"|"No"}
 *   customfield_10306  "SLA Due Time"    -- datetime
 *   customfield_10309  "SLA Start Time"  -- datetime
 *
 * Additive only: only ever sets these 3 columns, never touches status,
 * assignee, comments, or anything else about the ticket.
 *
 * Credentials: reads jira_url/jira_email/jira_token from app_settings first
 * (same as the app itself), falling back to JIRA_EMAIL/JIRA_TOKEN env vars.
 *
 * Env vars:
 *   DATABASE_URL          - optional, defaults to the local dev DB
 *   DRY_RUN               - default 'true'; pass 'false' to actually write
 *   BACKFILL_LIMIT        - optional, cap how many issues to process (test runs)
 *   BACKFILL_CONCURRENCY  - optional, default 6
 *   JIRA_EMAIL, JIRA_TOKEN - only used if app_settings has no stored credentials
 *
 * Run: node backfill-jira-sla-breach.mjs
 * Apply for real: DRY_RUN=false node backfill-jira-sla-breach.mjs
 */
import pg from 'pg';
import https from 'https';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const DRY_RUN = process.env.DRY_RUN !== 'false';
const LIMIT = process.env.BACKFILL_LIMIT ? parseInt(process.env.BACKFILL_LIMIT, 10) : Infinity;
const CONCURRENCY = process.env.BACKFILL_CONCURRENCY ? parseInt(process.env.BACKFILL_CONCURRENCY, 10) : 6;

const SLA_BREACHED_FIELD = 'customfield_10917';
const SLA_DUE_FIELD = 'customfield_10306';
const SLA_START_FIELD = 'customfield_10309';

async function getJiraCredentials() {
  try {
    const rows = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('jira_url','jira_email','jira_token')`);
    const s = {};
    for (const r of rows.rows) s[r.key] = r.value;
    if (s.jira_token && s.jira_email) {
      return { base: s.jira_url || 'https://cf2020.atlassian.net', email: s.jira_email, token: s.jira_token };
    }
  } catch { /* app_settings may not exist locally -- fall through to env */ }
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_TOKEN;
  if (!email || !token) {
    console.error('No Jira credentials in app_settings and JIRA_EMAIL/JIRA_TOKEN not set.');
    process.exit(1);
  }
  return { base: process.env.JIRA_BASE_URL || 'https://cf2020.atlassian.net', email, token };
}

function jiraGet(hostname, authHdr, path) {
  return new Promise((resolve, reject) => {
    https.get(
      { hostname, path, headers: { Authorization: authHdr, Accept: 'application/json' } },
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

async function jiraGetWithRetry(hostname, authHdr, path, attempt = 0) {
  try { return await jiraGet(hostname, authHdr, path); }
  catch (e) {
    if (e?.notFound) throw e;
    if (e?.retryable && attempt < 6) {
      await new Promise((r) => setTimeout(r, (e.retryAfter || 5) * 1000));
      return jiraGetWithRetry(hostname, authHdr, path, attempt + 1);
    }
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

async function main() {
  // Same raw columns the app's own jira-pg-api.ts reads/writes -- create them
  // here too so this script works even if it's run before the app code that
  // depends on them has been deployed.
  await pool.query(`
    ALTER TABLE issues ADD COLUMN IF NOT EXISTS jira_sla_breached BOOLEAN DEFAULT FALSE;
    ALTER TABLE issues ADD COLUMN IF NOT EXISTS jira_sla_due_at TIMESTAMPTZ;
    ALTER TABLE issues ADD COLUMN IF NOT EXISTS jira_sla_start_at TIMESTAMPTZ;
  `);

  const creds = await getJiraCredentials();
  const hostname = new URL(creds.base).hostname;
  const authHdr = 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64');

  const res = await pool.query(`
    SELECT id, key, jira_sla_breached, jira_sla_due_at, jira_sla_start_at
    FROM issues
    WHERE key LIKE 'L2B-%' OR key LIKE 'L3B-%'
    ORDER BY RANDOM()
  `);
  const targets = res.rows.slice(0, LIMIT === Infinity ? res.rows.length : LIMIT);
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Found ${res.rows.length} L2B/L3B tickets; processing ${targets.length} with concurrency=${CONCURRENCY}.`);

  const stats = { processed: 0, changed: 0, unchanged: 0, notFound: 0, errors: 0, breachedYes: 0, breachedNo: 0, noSlaData: 0 };
  const sample = [];

  await runPool(targets, async (row) => {
    try {
      let data;
      try {
        data = await jiraGetWithRetry(
          hostname, authHdr,
          `/rest/api/3/issue/${row.key}?fields=${SLA_BREACHED_FIELD},${SLA_DUE_FIELD},${SLA_START_FIELD}`
        );
      } catch (e) {
        if (e?.notFound) { stats.notFound++; return; }
        throw e;
      }
      const f = data.fields || {};
      // Jira returns this select field as an ARRAY (e.g. [{value:"Yes",...}]),
      // not a plain object -- .value on the array itself is always undefined.
      const rawOption = f[SLA_BREACHED_FIELD];
      const breachedOption = Array.isArray(rawOption) ? rawOption[0] : rawOption;
      if (!breachedOption) { stats.noSlaData++; return; } // ticket has no SLA breach field set at all -- leave untouched

      const breached = String(breachedOption.value || '').toLowerCase() === 'yes';
      const dueAt = f[SLA_DUE_FIELD] ? new Date(f[SLA_DUE_FIELD]) : null;
      const startAt = f[SLA_START_FIELD] ? new Date(f[SLA_START_FIELD]) : null;
      if (breached) stats.breachedYes++; else stats.breachedNo++;

      const alreadyCorrect = row.jira_sla_breached === breached
        && (row.jira_sla_due_at ? new Date(row.jira_sla_due_at).getTime() : null) === (dueAt ? dueAt.getTime() : null)
        && (row.jira_sla_start_at ? new Date(row.jira_sla_start_at).getTime() : null) === (startAt ? startAt.getTime() : null);
      if (alreadyCorrect) { stats.unchanged++; return; }

      if (sample.length < 20 && breached) {
        sample.push({ key: row.key, breached, dueAt: dueAt?.toISOString(), startAt: startAt?.toISOString() });
      }
      if (!DRY_RUN) {
        await pool.query(
          `UPDATE issues SET jira_sla_breached=$1, jira_sla_due_at=$2, jira_sla_start_at=$3 WHERE id=$4`,
          [breached, dueAt, startAt, row.id]
        );
      }
      stats.changed++;
    } catch (e) {
      stats.errors++;
      console.error(`[ERROR] ${row.key}:`, e?.message || e);
    }
    stats.processed++;
    if (stats.processed % 200 === 0) {
      console.log(`progress: ${stats.processed}/${targets.length} | changed=${stats.changed} unchanged=${stats.unchanged} breachedYes=${stats.breachedYes} noSlaData=${stats.noSlaData} notFound=${stats.notFound} errors=${stats.errors}`);
    }
  }, CONCURRENCY);

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Done.`);
  console.log(stats);
  console.log(`\nSample of breached tickets found (up to 20):`);
  console.log(sample);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
