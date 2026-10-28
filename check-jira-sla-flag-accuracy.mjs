// Read-only: spot-check whether the imported jira_sla_breached flag is
// actually trustworthy for the 1491 QA tickets with zero real in-app SLA
// tracking, before deciding whether to keep trusting it or treat them as
// N/A. Pulls each sample ticket's real SLA fields straight from Jira.
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
  const { rows: allRows } = await pool.query(`
    SELECT id, key, cf_key, dept_sla_log, sla_snapshot
    FROM issues
    WHERE sla_snapshot IS NOT NULL AND jsonb_array_length(sla_snapshot) > 0 AND jira_sla_breached = true
  `);
  const sample = allRows
    .filter((r) => (r.sla_snapshot || []).some((x) => x.deptName === 'QA' && x.isBreached && x.actualElapsedMs === 0))
    .sort(() => Math.random() - 0.5)
    .slice(0, 15);
  console.log(`Found ${allRows.filter((r) => (r.sla_snapshot || []).some((x) => x.deptName === 'QA' && x.isBreached && x.actualElapsedMs === 0)).length} total matching tickets, sampling ${sample.length}...\n`);

  const { base, authHdr } = await getJiraCreds();
  // customfield_10917 = Dev/L2B/L3B's own "SLA Breached" field,
  // customfield_10849 = Migration/CFITS's "Resolution SLA Breach" field --
  // same two fields extractJiraSlaBreach checks (see jira-pg-api.ts).
  for (const r of sample) {
    try {
      const res = await fetch(`${base}/rest/api/3/issue/${r.key}?fields=status,resolutiondate,customfield_10917,customfield_10849,customfield_10043`, {
        headers: { Authorization: authHdr, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { console.log(` - ${r.key}: Jira HTTP ${res.status}`); continue; }
      const ji = await res.json();
      const f = ji.fields || {};
      const slaBreachField = f.customfield_10917?.value || f.customfield_10917 || null;
      const resolutionSlaField = f.customfield_10849?.value || f.customfield_10849 || null;
      const nativeSla = f.customfield_10043 || null;
      console.log(` - ${r.key} (${r.cf_key}): status="${f.status?.name}" resolved=${f.resolutiondate} | SLA Breached field="${JSON.stringify(slaBreachField)}" | Resolution SLA Breach field="${JSON.stringify(resolutionSlaField)}" | native SLA metric present=${!!nativeSla}`);
    } catch (e) {
      console.log(` - ${r.key}: fetch failed -- ${e?.message || e}`);
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
