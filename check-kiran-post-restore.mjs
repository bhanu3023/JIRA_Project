// The Jira-restore just ran (19,588 tickets fixed, 0 errors), but
// Kiran's Queue:QA + Created+Updated Feb-Mar 2026 still shows 0.
// Checking her actual tickets' updatedAt now -- were they restored at
// all, or were they in the "not found in Jira" bucket (meaning these
// specific tickets don't exist in Jira anymore and couldn't be
// recovered)? Read-only.
//
// Usage: node check-kiran-post-restore.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT key, COALESCE(cf_key, key) AS cf_key, "createdAt", "updatedAt"
    FROM issues
    WHERE "assigneeId" = 'pg_vg1syvt79q' AND LOWER(current_department) = 'qa'
    ORDER BY "updatedAt" DESC
    LIMIT 20
  `);
  console.log('Kiran\'s QA tickets, most recently updated first (post-restore):');
  for (const r of rows) {
    console.log(`  ${r.key} (${r.cf_key}): created=${r.createdAt?.toISOString?.()} updated=${r.updatedAt?.toISOString?.()}`);
  }

  const { rows: dist } = await pool.query(`
    SELECT DATE("updatedAt") AS day, COUNT(*)::int AS cnt
    FROM issues
    WHERE "assigneeId" = 'pg_vg1syvt79q' AND LOWER(current_department) = 'qa'
    GROUP BY DATE("updatedAt")
    ORDER BY cnt DESC
    LIMIT 10
  `);
  console.log('\nUpdatedAt distribution for her QA tickets (post-restore):');
  console.log(JSON.stringify(dist, null, 2));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
