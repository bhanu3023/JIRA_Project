// Read-only: general post-deploy sanity check -- confirms the jira sync is
// still running (not stuck), checks for any comment history rows written
// in the last hour that are suspiciously truncated at exactly the old
// 80 or 500 char cutoffs (would mean the old code is somehow still live),
// and reports basic DB connectivity/counts.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: settings } = await pool.query(
    `SELECT key, value FROM app_settings WHERE key LIKE 'jira_sync%' ORDER BY key`
  );
  console.log('Jira sync settings:');
  for (const r of settings) console.log(` - ${r.key}: ${JSON.stringify(r.value).slice(0, 150)}`);

  const { rows: recentComments } = await pool.query(`
    SELECT h.id, COALESCE(i.cf_key, i.key) AS key, h."createdAt", LENGTH(h."newValue") AS len, h."newValue"
    FROM issue_history h
    JOIN issues i ON i.id = h."issueId"
    WHERE h.field = 'comment' AND h."createdAt" > NOW() - INTERVAL '2 hours'
    ORDER BY h."createdAt" DESC
    LIMIT 20
  `);
  console.log(`\nComment history rows written in the last 2 hours: ${recentComments.length}`);
  for (const r of recentComments) {
    const suspicious = r.len === 80 || r.len === 500;
    console.log(` - ${r.key} [${r.createdAt.toISOString()}] len=${r.len}${suspicious ? '  <-- SUSPICIOUS (matches old truncation cutoff)' : ''}`);
  }

  const { rows: counts } = await pool.query(`SELECT COUNT(*) FROM issues`);
  console.log(`\nTotal issues in DB: ${counts[0].count}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
