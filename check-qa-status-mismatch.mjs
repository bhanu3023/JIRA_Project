// Read-only follow-up to check-qa-missing-fields.mjs: that check found the
// "missing assignee/reporter" tickets actually match Jira (genuinely
// Unassigned there too), but spotted ONE real status mismatch (QA-1527:
// local "Resolved", Jira "Open") among just 8 samples. Widen the sample to
// see whether status drift is a one-off or a real, ongoing sync gap.
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

async function main() {
  const { rows: sample } = await pool.query(`
    SELECT i.key, i.cf_key, s.name AS status_name
    FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE i.key LIKE 'QA-%'
    ORDER BY RANDOM()
    LIMIT 50
  `);

  const { rows: checkpointRows } = await pool.query(
    `SELECT key, value, updated_at FROM app_settings WHERE key LIKE '%QA%' OR key LIKE 'jira_sync%'`
  ).catch(() => ({ rows: [] }));
  console.log('Sync checkpoint rows:', JSON.stringify(checkpointRows, null, 2));

  const { base, authHdr } = await getJiraCreds();
  let mismatches = 0, notFound = 0, matched = 0;
  for (const r of sample) {
    try {
      const res = await fetch(`${base}/rest/api/3/issue/${r.key}?fields=status`, {
        headers: { Authorization: authHdr, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 404) { notFound++; console.log(` - ${r.key} (${r.cf_key}): 404 in Jira (local status "${r.status_name}")`); continue; }
      if (!res.ok) { console.log(` - ${r.key}: Jira HTTP ${res.status}`); continue; }
      const ji = await res.json();
      const jiraStatus = ji.fields?.status?.name;
      if ((jiraStatus || '').toLowerCase() !== (r.status_name || '').toLowerCase()) {
        mismatches++;
        console.log(` - MISMATCH ${r.key} (${r.cf_key}): local="${r.status_name}" jira="${jiraStatus}"`);
      } else {
        matched++;
      }
    } catch (e) {
      console.log(` - ${r.key}: fetch failed -- ${e?.message || e}`);
    }
    await new Promise((res) => setTimeout(res, 150));
  }
  console.log(`\nOf ${sample.length} random QA tickets: ${matched} match Jira, ${mismatches} status mismatches, ${notFound} not found in Jira (404).`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
