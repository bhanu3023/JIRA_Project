/**
 * sync-qa-core-fields.mjs
 *
 * Reconciles every QA-* ticket against the real Jira QUALITY-ANALYST
 * project (Jira project key "QA" -- confirmed local QA-N keys are the
 * SAME tickets as Jira's real QA-N, not a separate positional numbering,
 * via check-qa-key-alignment.mjs). For each local QA-* issue, fetches the
 * matching Jira issue by key and fixes:
 *
 *   - createdAt / updatedAt  (from Jira's real created/updated -- QA
 *     tickets never had a real `updated` backfilled; some were also hit
 *     by the same "Prisma update() without passing updatedAt" bug already
 *     fixed for Dev/Migration, just never corrected for QA)
 *   - statusId (+ dept_statuses[current_department] snapshot, same dual
 *     write backfill-jira-status.mjs already does for Dev, matched by
 *     exact case-insensitive name against this space's own status list)
 *   - assigneeId / reporterId (resolved/created by email, same pattern as
 *     sync-all-assignees.mjs's resolvePerson)
 *   - parentKey (subtask parent link -- migrate-qab.mjs never requested
 *     or set this at all, so it's NULL for every QA issue today)
 *   - issue_links (Jira's issuelinks field for this ticket, upserted into
 *     the issue_links table; also removes this ticket's own stale
 *     orphaned link rows recorded under an old key scheme that no longer
 *     matches any real issue)
 *
 * SAFE BY DEFAULT: dry run unless DRY_RUN=false is passed explicitly.
 *
 * Credentials: reads jira_url/jira_email/jira_token from the app_settings
 * table first (same as the app itself), falling back to JIRA_EMAIL/
 * JIRA_TOKEN env vars -- never hardcode these.
 *
 * Env vars:
 *   DATABASE_URL           - optional, defaults to the local dev DB
 *   DRY_RUN                - default 'true'; pass 'false' to actually write
 *   BACKFILL_LIMIT         - optional, cap how many issues to process (test runs)
 *   BACKFILL_CONCURRENCY   - optional, default 6
 *   JIRA_EMAIL, JIRA_TOKEN - only used if app_settings has no stored credentials
 *
 * Run: node sync-qa-core-fields.mjs
 * Apply for real: DRY_RUN=false node sync-qa-core-fields.mjs
 */
import pg from 'pg';
import https from 'https';
import crypto from 'crypto';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});
const rid = () => 'usr_' + crypto.randomBytes(10).toString('hex');

const DRY_RUN = process.env.DRY_RUN !== 'false';
const LIMIT = process.env.BACKFILL_LIMIT ? parseInt(process.env.BACKFILL_LIMIT, 10) : Infinity;
const CONCURRENCY = process.env.BACKFILL_CONCURRENCY ? parseInt(process.env.BACKFILL_CONCURRENCY, 10) : 6;
// Anything closer than this is treated as "already correct" (clock/precision
// noise), not a real drift worth writing.
const TIME_TOLERANCE_MS = 2000;

async function getJiraCredentials() {
  try {
    const rows = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('jira_url','jira_email','jira_token')`);
    const s = {};
    for (const r of rows.rows) s[r.key] = r.value;
    if (s.jira_token && s.jira_email) {
      return { base: s.jira_url || 'https://cf2020.atlassian.net', email: s.jira_email, token: s.jira_token };
    }
  } catch { /* app_settings may not exist locally -- fall through to env */ }
  const email = (process.env.JIRA_EMAIL || '').trim();
  const token = (process.env.JIRA_TOKEN || '').trim();
  if (!email || !token) {
    console.error('No Jira credentials in app_settings and JIRA_EMAIL/JIRA_TOKEN not set.');
    process.exit(1);
  }
  return { base: (process.env.JIRA_BASE_URL || 'https://cf2020.atlassian.net').trim(), email, token };
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

// ── User resolution (create-if-missing, same shape as sync-all-assignees.mjs) ──
const userCache = new Map(); // accountId -> local user id
const wouldCreateUsers = new Set(); // dry-run only: emails that would need a new local user
async function resolvePerson(jiraUser) {
  if (!jiraUser) return null;
  const accountId = jiraUser.accountId || '';
  if (accountId && userCache.has(accountId)) return userCache.get(accountId);

  const email = (jiraUser.emailAddress || '').toLowerCase();
  const displayName = (jiraUser.displayName || '').trim();

  if (email) {
    const byEmail = await pool.query('SELECT id FROM users WHERE LOWER(email)=$1 LIMIT 1', [email]);
    if (byEmail.rows[0]) {
      if (accountId) userCache.set(accountId, byEmail.rows[0].id);
      return byEmail.rows[0].id;
    }
  }
  if (displayName) {
    const byName = await pool.query(
      `SELECT id FROM users WHERE LOWER("displayName")=LOWER($1) OR LOWER("firstName" || ' ' || "lastName")=LOWER($1) LIMIT 1`,
      [displayName]
    );
    if (byName.rows[0]) {
      if (accountId) userCache.set(accountId, byName.rows[0].id);
      return byName.rows[0].id;
    }
  }

  const emailToUse = email || `jira_${(accountId || 'unknown').slice(0, 10)}@cloudfuze.com`;
  // No local user matches yet. A dry run must not create one -- there's
  // nothing safe to return here (no real id exists), so report it via
  // wouldCreateUsers and leave this ticket's assignee/reporter untouched
  // for THIS run rather than fabricating an id or writing for real.
  if (DRY_RUN) {
    wouldCreateUsers.add(emailToUse);
    return null;
  }
  const parts = displayName.split(/\s+/).filter(Boolean);
  const newId = rid();
  try {
    await pool.query(
      `INSERT INTO users (id, email, "firstName", "lastName", "displayName", password, role, "isActive")
       VALUES ($1,$2,$3,$4,$5,'changeme123','agent',true)
       ON CONFLICT (email) DO UPDATE SET "displayName" = EXCLUDED."displayName"
       RETURNING id`,
      [newId, emailToUse, parts[0] || displayName || 'Unknown', parts.slice(1).join(' '), displayName || emailToUse]
    );
    const row = await pool.query('SELECT id FROM users WHERE email=$1', [emailToUse]);
    const id = row.rows[0]?.id || newId;
    if (accountId) userCache.set(accountId, id);
    return id;
  } catch {
    return null;
  }
}

async function main() {
  const creds = await getJiraCredentials();
  const hostname = new URL(creds.base).hostname;
  const authHdr = 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64');

  const res = await pool.query(`
    SELECT id, key, "createdAt", "updatedAt", "statusId", "spaceId", "parentKey", "assigneeId", "reporterId", current_department, dept_statuses
    FROM issues WHERE key LIKE 'QA-%'
    ORDER BY RANDOM()
  `);
  const targets = res.rows.slice(0, LIMIT === Infinity ? res.rows.length : LIMIT);
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Found ${res.rows.length} QA tickets; processing ${targets.length} with concurrency=${CONCURRENCY}.`);

  const spaceId = targets[0]?.spaceId;
  const statusRows = spaceId ? await pool.query(`SELECT id, name, color, category FROM statuses WHERE "spaceId"=$1`, [spaceId]) : { rows: [] };
  const statusByName = new Map(statusRows.rows.map((s) => [s.name.toLowerCase(), s]));
  console.log(`Loaded ${statusRows.rows.length} local statuses for this space.`);

  // One-time global cleanup: issue_links rows recorded under an OLD key
  // scheme (e.g. "QAB-118") that predates the current "QA-N" keys no longer
  // match any real issue at all -- the per-ticket cleanup below only ever
  // looks at rows filed under a ticket's OWN current key, so it can never
  // reach these. Confirmed via inspect-qa-board.mjs: every single QA%-prefixed
  // issue_links row today is orphaned this way.
  const orphaned = await pool.query(`
    SELECT id, "sourceKey", "targetKey", "linkType" FROM issue_links il
    WHERE il."sourceKey" LIKE 'QA%' AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.key = il."sourceKey")
  `);
  console.log(`\n${DRY_RUN ? '[DRY RUN] Would remove' : 'Removed'} ${orphaned.rows.length} orphaned issue_links row(s) under a stale key scheme (e.g. "QAB-*") that matches no current issue.`);
  if (!DRY_RUN && orphaned.rows.length) {
    await pool.query(`DELETE FROM issue_links WHERE id = ANY($1::text[])`, [orphaned.rows.map((r) => r.id)]);
  }

  const stats = {
    processed: 0, notFound: 0, errors: 0,
    createdAtFixed: 0, updatedAtFixed: 0, statusFixed: 0,
    assigneeFixed: 0, reporterFixed: 0, parentKeyFixed: 0,
    linksAdded: 0, staleLinksRemoved: 0,
  };
  const unmatchedStatuses = [];
  const sample = [];

  await runPool(targets, async (row) => {
    try {
      let data;
      try {
        data = await jiraGetWithRetry(
          hostname, authHdr,
          `/rest/api/3/issue/${row.key}?fields=status,assignee,reporter,created,updated,parent,issuelinks`
        );
      } catch (e) {
        if (e?.notFound) { stats.notFound++; return; }
        throw e;
      }
      const f = data.fields || {};
      const entry = { key: row.key, changes: [] };

      // -- created / updated --
      const realCreated = f.created ? new Date(f.created) : null;
      const realUpdated = f.updated ? new Date(f.updated) : null;
      const createdDiff = realCreated ? Math.abs(new Date(row.createdAt).getTime() - realCreated.getTime()) : 0;
      const updatedDiff = realUpdated ? Math.abs(new Date(row.updatedAt).getTime() - realUpdated.getTime()) : 0;
      const fixCreated = realCreated && createdDiff > TIME_TOLERANCE_MS;
      const fixUpdated = realUpdated && updatedDiff > TIME_TOLERANCE_MS;
      if (fixCreated) { stats.createdAtFixed++; entry.changes.push(`createdAt ${row.createdAt.toISOString()} -> ${realCreated.toISOString()}`); }
      if (fixUpdated) { stats.updatedAtFixed++; entry.changes.push(`updatedAt ${row.updatedAt.toISOString()} -> ${realUpdated.toISOString()}`); }

      // -- status --
      let matchedStatus = null;
      const jiraStatusName = f.status?.name;
      if (jiraStatusName) {
        matchedStatus = statusByName.get(jiraStatusName.toLowerCase()) || null;
        if (!matchedStatus) unmatchedStatuses.push({ key: row.key, jiraStatus: jiraStatusName });
      }
      const statusChanged = matchedStatus && matchedStatus.id !== row.statusId;
      if (statusChanged) { stats.statusFixed++; entry.changes.push(`status -> ${matchedStatus.name}`); }

      // -- assignee / reporter --
      const resolvedAssigneeId = await resolvePerson(f.assignee);
      const resolvedReporterId = await resolvePerson(f.reporter);
      const assigneeChanged = resolvedAssigneeId && resolvedAssigneeId !== row.assigneeId;
      const reporterChanged = resolvedReporterId && resolvedReporterId !== row.reporterId;
      if (assigneeChanged) { stats.assigneeFixed++; entry.changes.push(`assignee -> ${f.assignee?.displayName || resolvedAssigneeId}`); }
      if (reporterChanged) { stats.reporterFixed++; entry.changes.push(`reporter -> ${f.reporter?.displayName || resolvedReporterId}`); }

      // -- parentKey --
      const jiraParentKey = f.parent?.key || null;
      const parentKeyChanged = jiraParentKey !== row.parentKey;
      if (parentKeyChanged) { stats.parentKeyFixed++; entry.changes.push(`parentKey -> ${jiraParentKey}`); }

      if (!DRY_RUN) {
        const setParts = [];
        const params = [];
        let p = 1;
        if (fixCreated) { setParts.push(`"createdAt"=$${p++}`); params.push(realCreated); }
        if (fixUpdated) { setParts.push(`"updatedAt"=$${p++}`); params.push(realUpdated); }
        if (statusChanged) { setParts.push(`"statusId"=$${p++}`); params.push(matchedStatus.id); }
        if (assigneeChanged) { setParts.push(`"assigneeId"=$${p++}`); params.push(resolvedAssigneeId); }
        if (reporterChanged) { setParts.push(`"reporterId"=$${p++}`); params.push(resolvedReporterId); }
        if (parentKeyChanged) { setParts.push(`"parentKey"=$${p++}`); params.push(jiraParentKey); }
        if (statusChanged) {
          const dept = row.current_department;
          const deptStatuses = { ...(row.dept_statuses || {}) };
          if (dept) deptStatuses[dept] = { id: matchedStatus.id, name: matchedStatus.name, color: matchedStatus.color, category: matchedStatus.category };
          setParts.push(`dept_statuses=$${p++}::jsonb`);
          params.push(JSON.stringify(deptStatuses));
        }
        if (setParts.length > 0) {
          params.push(row.id);
          await pool.query(`UPDATE issues SET ${setParts.join(', ')} WHERE id=$${p}`, params);
        }
      }

      // -- issue_links: remove this ticket's own stale rows, insert current ones --
      // Direct, unambiguous cleanup: any row already recorded under exactly
      // this issue's own key that Jira no longer reports is stale for THIS
      // issue specifically (safe to touch regardless of other tickets).
      const currentLinks = (f.issuelinks || []).map((lnk) => {
        const other = lnk.outwardIssue || lnk.inwardIssue;
        return other ? { targetKey: other.key, linkType: (lnk.type?.name || 'relates').toLowerCase() } : null;
      }).filter(Boolean);

      const existingLinks = await pool.query(`SELECT "targetKey", "linkType" FROM issue_links WHERE "sourceKey"=$1`, [row.key]);
      const existingSet = new Set(existingLinks.rows.map((r) => `${r.targetKey}|${r.linkType}`));
      const currentSet = new Set(currentLinks.map((l) => `${l.targetKey}|${l.linkType}`));

      const toAdd = currentLinks.filter((l) => !existingSet.has(`${l.targetKey}|${l.linkType}`));
      const toRemove = existingLinks.rows.filter((r) => !currentSet.has(`${r.targetKey}|${r.linkType}`));

      if (toAdd.length) { stats.linksAdded += toAdd.length; entry.changes.push(`+${toAdd.length} link(s)`); }
      if (toRemove.length) { stats.staleLinksRemoved += toRemove.length; entry.changes.push(`-${toRemove.length} stale link(s)`); }

      if (!DRY_RUN) {
        for (const l of toAdd) {
          await pool.query(
            `INSERT INTO issue_links (id, "sourceKey", "targetKey", "linkType") VALUES ($1,$2,$3,$4)
             ON CONFLICT ("sourceKey","targetKey","linkType") DO NOTHING`,
            [rid(), row.key, l.targetKey, l.linkType]
          );
        }
        for (const r of toRemove) {
          await pool.query(`DELETE FROM issue_links WHERE "sourceKey"=$1 AND "targetKey"=$2 AND "linkType"=$3`, [row.key, r.targetKey, r.linkType]);
        }
      }

      if (entry.changes.length && sample.length < 25) sample.push(entry);
    } catch (e) {
      stats.errors++;
      console.error(`[ERROR] ${row.key}:`, e?.message || e);
    }
    stats.processed++;
    if (stats.processed % 200 === 0) {
      console.log(`progress: ${stats.processed}/${targets.length} |`, stats);
    }
  }, CONCURRENCY);

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Done.`);
  console.log(stats);
  if (wouldCreateUsers.size) {
    console.log(`\n[DRY RUN] ${wouldCreateUsers.size} distinct email(s) would need a new local user created on a real run (not created, and their assignee/reporter fix was skipped this dry run as a result):`);
    console.log(JSON.stringify([...wouldCreateUsers].slice(0, 30), null, 2));
  }
  if (unmatchedStatuses.length) {
    console.log(`\n${unmatchedStatuses.length} Jira status name(s) had no local match (not changed, needs manual review):`);
    console.log(JSON.stringify(unmatchedStatuses.slice(0, 30), null, 2));
  }
  console.log('\nSample of tickets with changes (first 25):');
  console.log(JSON.stringify(sample, null, 2));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
