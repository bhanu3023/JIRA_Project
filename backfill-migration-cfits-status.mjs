/**
 * backfill-migration-cfits-status.mjs
 *
 * Syncs the local status of every Migration-queue ticket migrated from Jira
 * project CFITS to match whatever status that ticket currently has in real
 * Jira. Same idea as backfill-jira-status.mjs (which covers L2B/L3B ->
 * Dev), but for a different source project/queue -- and critically, the
 * Jira lookup key is NOT the local ticket key here. Migration-queue tickets
 * keep their local key as L1BOAR-#### while the real Jira issue lives at
 * CFITS-#### (stored in issues.jira_source_key) -- looking these up by
 * local key the way the Dev-queue script does would 404 on every single one.
 *
 * Scope: current_department = 'Migration' (case-insensitive) AND
 * jira_source_key LIKE 'CFITS-%'. Tickets with no jira_source_key were
 * created locally, not migrated, and are left alone.
 *
 * Updates both the global issues.statusId AND the per-department
 * dept_statuses['Migration'] snapshot -- same two-places-to-update
 * reasoning as the Dev-queue script (the queue's own list reads
 * dept_statuses first, falling back to global status only if absent).
 *
 * Status matching is by exact (case-insensitive) name against the space's
 * own status list. A Jira status with no exact local match is reported,
 * never guessed.
 *
 * SAFE BY DEFAULT: runs as a dry run (reports what WOULD change, writes
 * nothing) unless DRY_RUN=false is passed explicitly.
 *
 * Credentials: reads jira_url/jira_email/jira_token from the app_settings
 * table first (same as the app itself), falling back to JIRA_EMAIL/
 * JIRA_TOKEN env vars if that table has nothing -- never hardcode these.
 *
 * Env vars:
 *   DATABASE_URL          - optional, defaults to the local dev DB
 *   DRY_RUN               - default 'true'; pass 'false' to actually write
 *   BACKFILL_LIMIT        - optional, cap how many issues to process (test runs)
 *   BACKFILL_CONCURRENCY  - optional, default 6
 *   JIRA_EMAIL, JIRA_TOKEN - only used if app_settings has no stored credentials
 *
 * Run: node backfill-migration-cfits-status.mjs
 * Apply for real: DRY_RUN=false node backfill-migration-cfits-status.mjs
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
  const creds = await getJiraCredentials();
  const hostname = new URL(creds.base).hostname;
  const authHdr = 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64');

  // ORDER BY RANDOM() -- see backfill-jira-status.mjs for why (lexicographic
  // key sort clusters a limited dry run into an unrepresentative sample).
  const res = await pool.query(`
    SELECT i.id, i.key, i.jira_source_key, i."statusId", i.current_department, i.dept_statuses, i."spaceId"
    FROM issues i
    WHERE LOWER(i.current_department) = 'migration' AND i.jira_source_key LIKE 'CFITS-%'
    ORDER BY RANDOM()
  `);
  const targets = res.rows.slice(0, LIMIT === Infinity ? res.rows.length : LIMIT);
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Found ${res.rows.length} Migration/CFITS tickets; processing ${targets.length} with concurrency=${CONCURRENCY}.`);

  const spaceId = targets[0]?.spaceId;
  const statusRows = spaceId ? await pool.query(`SELECT id, name, color, category FROM statuses WHERE "spaceId"=$1`, [spaceId]) : { rows: [] };
  const statusByName = new Map(statusRows.rows.map((s) => [s.name.toLowerCase(), s]));
  console.log(`Loaded ${statusRows.rows.length} local statuses for this space.`);

  const stats = { processed: 0, changed: 0, unchanged: 0, notFound: 0, errors: 0 };
  const unmatched = [];
  const sample = [];
  const jiraStatusCounts = {};
  const changeKinds = { valueChanged: 0, snapshotBackfillOnly: 0, wasNull: 0 };

  await runPool(targets, async (row) => {
    try {
      let data;
      try {
        data = await jiraGetWithRetry(hostname, authHdr, `/rest/api/3/issue/${row.jira_source_key}?fields=status`);
      } catch (e) {
        if (e?.notFound) { stats.notFound++; return; }
        throw e;
      }
      const jiraStatusName = data.fields?.status?.name;
      if (!jiraStatusName) { unmatched.push({ key: row.key, sourceKey: row.jira_source_key, reason: 'no status field in Jira response' }); return; }
      jiraStatusCounts[jiraStatusName] = (jiraStatusCounts[jiraStatusName] || 0) + 1;

      const matched = statusByName.get(jiraStatusName.toLowerCase());
      if (!matched) { unmatched.push({ key: row.key, sourceKey: row.jira_source_key, jiraStatus: jiraStatusName }); return; }

      const dept = row.current_department;
      const deptStatuses = row.dept_statuses || {};
      const deptAlreadyCorrect = !dept || deptStatuses[dept]?.id === matched.id;
      const globalAlreadyCorrect = row.statusId === matched.id;
      if (globalAlreadyCorrect && deptAlreadyCorrect) { stats.unchanged++; return; }

      if (row.statusId === null) changeKinds.wasNull++;
      else if (globalAlreadyCorrect) changeKinds.snapshotBackfillOnly++;
      else changeKinds.valueChanged++;
      if (sample.length < 20) {
        sample.push({ key: row.key, sourceKey: row.jira_source_key, dept, from: row.statusId, jiraStatus: jiraStatusName, to: matched.name });
      }
      if (!DRY_RUN) {
        const newDeptStatuses = { ...deptStatuses };
        if (dept) newDeptStatuses[dept] = { id: matched.id, name: matched.name, color: matched.color, category: matched.category };
        await pool.query(
          `UPDATE issues SET "statusId"=$1, dept_statuses=$2::jsonb WHERE id=$3`,
          [matched.id, JSON.stringify(newDeptStatuses), row.id]
        );
      }
      stats.changed++;
    } catch (e) {
      stats.errors++;
      console.error(`[ERROR] ${row.key} (${row.jira_source_key}):`, e?.message || e);
    }
    stats.processed++;
    if (stats.processed % 200 === 0) {
      console.log(`progress: ${stats.processed}/${targets.length} | changed=${stats.changed} unchanged=${stats.unchanged} unmatched=${unmatched.length} notFound=${stats.notFound} errors=${stats.errors}`);
    }
  }, CONCURRENCY);

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Done.`);
  console.log(stats);
  console.log('\nOf the changed tickets: previously null vs a real value flip vs just backfilling the empty dept_statuses snapshot:');
  console.log(changeKinds);

  console.log('\nDistribution of tickets\' REAL current status in Jira (across everything checked, not just changes):');
  console.log(Object.fromEntries(Object.entries(jiraStatusCounts).sort((a, b) => b[1] - a[1])));

  console.log(`\nSample of ${sample.length > 0 ? 'up to 20 ' : ''}changes${DRY_RUN ? ' (would apply)' : ' applied'}:`);
  console.log(sample);

  if (unmatched.length) {
    const counts = {};
    for (const u of unmatched) {
      const k = u.jiraStatus || u.reason;
      counts[k] = (counts[k] || 0) + 1;
    }
    console.log(`\n${unmatched.length} tickets had a Jira status with no local match (nothing changed for these):`);
    console.log(counts);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
