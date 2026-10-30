// Read-only: does this app already have working Jira API credentials
// stored (app_settings table, or env vars), from its original migration
// setup? Never prints the actual token value -- only presence and
// whether a real API call with it succeeds.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('jira_url','jira_email','jira_token')`).catch(() => ({ rows: [] }));
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const base  = s.jira_url   || process.env.JIRA_BASE_URL;
  const email = s.jira_email || process.env.JIRA_EMAIL;
  const token = s.jira_token || process.env.JIRA_TOKEN;

  console.log('jira_url present:', !!base, base ? `(${base})` : '');
  console.log('jira_email present:', !!email, email ? `(${email})` : '');
  console.log('jira_token present:', !!token, token ? `(${token.length} chars)` : '');

  if (!base || !email || !token) {
    console.log('\nMissing one or more credentials -- cannot test a real API call.');
    await pool.end();
    return;
  }

  const authHdr = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  console.log('\n--- Testing a real Jira API call (GET /rest/api/3/myself) ---');
  const res = await fetch(`${base}/rest/api/3/myself`, { headers: { Authorization: authHdr, Accept: 'application/json' } });
  console.log('Status:', res.status);
  if (res.ok) {
    const me = await res.json();
    console.log('Authenticated as:', me.displayName, `(${me.emailAddress})`);
  } else {
    console.log('Body:', await res.text().catch(() => '(unreadable)'));
  }

  // Also check: do L2-Board / L3-Board projects exist and are they reachable?
  for (const projKey of ['L2B', 'L3B', 'L2', 'L3']) {
    const pRes = await fetch(`${base}/rest/api/3/project/${projKey}`, { headers: { Authorization: authHdr, Accept: 'application/json' } });
    console.log(`\nProject "${projKey}":`, pRes.status, pRes.ok ? '(exists)' : '');
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
