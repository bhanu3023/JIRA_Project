// Checks whether the periodic Jira sync (instrumentation.ts -> runJiraIssueSync,
// every 5 minutes) actually refreshes an EXISTING ticket's assignee/status, or
// only ever imports brand-new tickets and then never looks at that ticket
// again. Reading runJiraIssueSync's own code (jira-pg-api.ts ~4708-4723): once
// `db.issue.findUnique({ where: { key } })` finds the ticket already exists
// locally, it's marked "ok" and skipped entirely -- no re-fetch of its current
// Jira state ever happens. This directly fetches a handful of real tickets
// from BOTH our local DB and live Jira to confirm whether that theory holds:
// does Jira actually show a different (more current) assignee/status than
// what's stored locally for these specific tickets?
// Read-only (does not import the 'pg' pool import used elsewhere in this repo
// for DB reads, and only does a GET against the Jira REST API).
//
// Usage: node check-jira-sync-staleness.mjs CF-33988 CF-33960 CF-29355 CF-22904
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const keys = process.argv.slice(2);
if (!keys.length) { console.log('Usage: node check-jira-sync-staleness.mjs <CF-KEY> [<CF-KEY> ...]'); process.exit(1); }

async function getJiraCreds() {
  const rows = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('jira_url','jira_email','jira_token')`);
  const s = {};
  for (const r of rows.rows) s[r.key] = r.value;
  if (!s.jira_token) throw new Error('No jira_token in app_settings');
  return { base: s.jira_url, authHdr: 'Basic ' + Buffer.from(`${s.jira_email}:${s.jira_token}`).toString('base64') };
}

async function main() {
  const creds = await getJiraCreds();

  for (const cfKey of keys) {
    const { rows } = await pool.query(`
      SELECT i.key, i.cf_key, i.jira_source_key, i."assigneeId", i."updatedAt", i."createdAt",
             u."firstName", u."lastName", s.name AS status_name, s.category AS status_category
      FROM issues i
      LEFT JOIN users u ON u.id = i."assigneeId"
      LEFT JOIN statuses s ON s.id = i."statusId"
      WHERE i.cf_key = $1 OR i.key = $1 LIMIT 1
    `, [cfKey]);
    const local = rows[0];
    console.log(`\n=== ${cfKey} ===`);
    if (!local) { console.log('  Not found locally.'); continue; }
    console.log(`  Local key: ${local.key}  jira_source_key: ${local.jira_source_key}`);
    console.log(`  Local assignee: ${local.firstName ? `${local.firstName} ${local.lastName}` : 'Unassigned'}`);
    console.log(`  Local status: ${local.status_name} (${local.status_category})`);
    console.log(`  Local createdAt: ${local.createdAt}  updatedAt: ${local.updatedAt}`);

    const jiraKey = local.jira_source_key || local.key;
    const res = await fetch(`${creds.base}/rest/api/3/issue/${jiraKey}?fields=assignee,status,summary,updated`, {
      headers: { Authorization: creds.authHdr, Accept: 'application/json' },
    }).catch((e) => { console.log(`  Jira fetch failed: ${e?.message || e}`); return null; });
    if (!res) continue;
    if (!res.ok) { console.log(`  Jira HTTP ${res.status}`); continue; }
    const data = await res.json().catch(() => null);
    if (!data) { console.log('  Bad JSON from Jira'); continue; }
    console.log(`  JIRA assignee: ${data.fields?.assignee?.displayName || 'Unassigned'}`);
    console.log(`  JIRA status: ${data.fields?.status?.name} (${data.fields?.status?.statusCategory?.key})`);
    console.log(`  JIRA updated: ${data.fields?.updated}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
