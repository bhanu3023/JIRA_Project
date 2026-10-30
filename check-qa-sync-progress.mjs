// Read-only: honest progress check before telling the user "yes, done".
// Checkpoints (2026-05-12 for QA, 2025-12-08 for PSM, 2026-03-10 for L2B,
// 2025-11-03 for CFITS) are all still MONTHS behind today -- only SOPS is
// nearly caught up. That means there's still a real backlog of tickets
// updated in Jira between each project's checkpoint date and now that
// haven't been refreshed locally yet. Spot-check a random sample per
// project against live Jira to see the CURRENT actual match rate, not just
// whether the mechanism is moving.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function getJiraCreds() {
  const { rows } = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('jira_url','jira_email','jira_token')`);
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  const base = s.jira_url || process.env.JIRA_BASE_URL || 'https://cf2020.atlassian.net';
  const email = s.jira_email || process.env.JIRA_EMAIL || '';
  const token = s.jira_token || process.env.JIRA_TOKEN || '';
  const authHdr = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  return { base, authHdr };
}

const PROJECTS = [
  { prefix: 'QA',  keyLike: 'QA-%' },
  { prefix: 'PSM', keyLike: 'PSM-%' },
  { prefix: 'L2B', keyLike: 'L2B-%' },
];

async function main() {
  const { base, authHdr } = await getJiraCreds();
  for (const { prefix, keyLike } of PROJECTS) {
    const { rows: sample } = await pool.query(`
      SELECT i.key, i.cf_key, s.name AS status_name, i."updatedAt", i."resolvedAt"
      FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
      WHERE i.key LIKE $1
      ORDER BY RANDOM() LIMIT 10
    `, [keyLike]);
    console.log(`\n=== ${prefix}: checking ${sample.length} random tickets against live Jira ===`);
    let matched = 0, mismatched = 0, notFound = 0;
    for (const r of sample) {
      try {
        const res = await fetch(`${base}/rest/api/3/issue/${r.key}?fields=status,updated,resolutiondate`, {
          headers: { Authorization: authHdr, Accept: 'application/json' },
          signal: AbortSignal.timeout(10000),
        });
        if (res.status === 404) { notFound++; console.log(` - ${r.key}: 404 in Jira`); continue; }
        if (!res.ok) { console.log(` - ${r.key}: Jira HTTP ${res.status}`); continue; }
        const ji = await res.json();
        const jiraStatus = ji.fields?.status?.name || '';
        const localStatus = r.status_name || '';
        const ok = jiraStatus.toLowerCase() === localStatus.toLowerCase();
        if (ok) matched++; else mismatched++;
        console.log(` - ${r.key} (${r.cf_key}): ${ok ? 'MATCH' : 'MISMATCH'} local="${localStatus}" jira="${jiraStatus}" | local updatedAt=${r.updatedAt?.toISOString().slice(0,10)} jira updated=${(ji.fields?.updated||'').slice(0,10)}`);
      } catch (e) {
        console.log(` - ${r.key}: fetch failed -- ${e?.message || e}`);
      }
      await new Promise((res) => setTimeout(res, 150));
    }
    console.log(`${prefix}: ${matched} matched, ${mismatched} mismatched, ${notFound} not found (of ${sample.length})`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
