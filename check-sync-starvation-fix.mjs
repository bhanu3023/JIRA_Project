// Read-only: confirm the fair-share fix to the "changed in Jira" catch-up
// pass actually took effect after deploy -- checkpoint rows for
// QA/PSM/SOPS/L3B/CFITS should now exist (they never did before, since L2B
// always ate the whole shared budget first) and keep advancing on each
// 5-minute tick.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT key, value, updated_at FROM app_settings
     WHERE key LIKE 'jira_sync_updated_checkpoint_%'
     ORDER BY key`
  );
  console.log('jira_sync_updated_checkpoint_* rows (one per project, catch-up progress):');
  for (const r of rows) console.log(` - ${r.key}: ${r.value} (updated_at ${r.updated_at.toISOString()})`);

  const expected = ['L2B', 'L3B', 'PSM', 'SOPS', 'QA', 'CFITS'];
  const present = new Set(rows.map((r) => r.key.replace('jira_sync_updated_checkpoint_', '')));
  console.log('\nMissing checkpoint rows (should be empty now):', expected.filter((p) => !present.has(p)));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
