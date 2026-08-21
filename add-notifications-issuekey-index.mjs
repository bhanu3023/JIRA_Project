/**
 * add-notifications-issuekey-index.mjs
 * FIX (idempotent, safe to re-run). Creates the missing index that lets
 * computeIssueSLAsFromDb's per-ticket-page-load query --
 *   SELECT id FROM notifications WHERE "issueKey" = $1 AND type = 'SLA_BREACH' LIMIT 1
 * -- (jira-pg-api.ts, computeIssueSLAsFromDb) and the equivalent batched
 * lookup used by the my-dashboard list --
 *   SELECT DISTINCT "issueKey" FROM notifications WHERE "issueKey" = ANY($1::text[]) AND type = 'SLA_BREACH'
 * -- use an index instead of a full sequential scan of the notifications
 * table. The Prisma schema only defines (userId, isRead) and
 * (userId, createdAt) indexes on Notification -- neither covers a lookup by
 * issueKey. This same CREATE INDEX statement has also been added to
 * deploy.sh's post-setup SQL block so future deploys create it automatically;
 * this script exists to apply it immediately without waiting for the next
 * deploy.
 *
 * CREATE INDEX CONCURRENTLY avoids locking the table for writes while it
 * builds, at the cost of taking somewhat longer than a plain CREATE INDEX.
 *
 * Run: DATABASE_URL=... node add-notifications-issuekey-index.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

async function main() {
  console.log('Checking existing indexes on notifications...');
  const before = await pool.query(`
    SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'notifications' ORDER BY indexname
  `);
  before.rows.forEach(r => console.log(`  ${r.indexname}: ${r.indexdef}`));

  console.log('\nCreating idx_notifications_issuekey_type (CONCURRENTLY)...');
  try {
    await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_issuekey_type ON notifications ("issueKey", type)`);
    console.log('  ✓ done (or already existed)');
  } catch (e) {
    console.log('  ✗ failed:', e.message);
    console.log('  Falling back to a plain (non-concurrent) CREATE INDEX...');
    try {
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_issuekey_type ON notifications ("issueKey", type)`);
      console.log('  ✓ done (non-concurrent)');
    } catch (e2) {
      console.log('  ✗ still failed:', e2.message);
      await pool.end();
      process.exit(1);
    }
  }

  console.log('\nVerifying with EXPLAIN...');
  const plan = await pool.query(`
    EXPLAIN SELECT id FROM notifications WHERE "issueKey" = 'DEV-1' AND type = 'SLA_BREACH' LIMIT 1
  `);
  plan.rows.forEach(r => console.log(' ', r['QUERY PLAN']));
  const usesIndex = plan.rows.some(r => /idx_notifications_issuekey_type/.test(r['QUERY PLAN']));
  console.log(usesIndex ? '\n✓ Planner is using the new index.' : '\n⚠ Planner did not pick the new index for this sample query (may still be correct depending on table size/stats -- run ANALYZE notifications; and re-check).');

  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
