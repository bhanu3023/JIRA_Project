// Read-only: why didn't L3B-642/648/650 match in the dry run? Fetch each
// key directly (no title-match gate this time) to see the raw result --
// does the key exist at all in Jira, and if so, does the title actually
// differ from local?
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = ['L3B-642', 'L3B-648', 'L3B-650'];

async function main() {
  const { rows: credRows } = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('jira_url','jira_email','jira_token')`);
  const s = Object.fromEntries(credRows.map((r) => [r.key, r.value]));
  const authHdr = 'Basic ' + Buffer.from(`${s.jira_email}:${s.jira_token}`).toString('base64');

  for (const key of KEYS) {
    console.log(`\n--- ${key} ---`);
    const { rows: local } = await pool.query(
      `SELECT key, summary, "createdAt", jira_source_key FROM issues WHERE key = $1`,
      [key]
    );
    console.log('Local row:', local[0] ? { summary: local[0].summary, createdAt: local[0].createdAt, jira_source_key: local[0].jira_source_key } : 'NOT FOUND LOCALLY');

    const res = await fetch(`${s.jira_url}/rest/api/3/issue/${key}?fields=summary,status,project`, {
      headers: { Authorization: authHdr, Accept: 'application/json' },
    });
    console.log('Jira API status:', res.status);
    if (res.ok) {
      const ji = await res.json();
      console.log('Jira title:', ji.fields?.summary);
      console.log('Jira project:', ji.fields?.project?.key);
      console.log('Jira status:', ji.fields?.status?.name);
    } else {
      console.log('Jira body:', await res.text().catch(() => '(unreadable)'));
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
