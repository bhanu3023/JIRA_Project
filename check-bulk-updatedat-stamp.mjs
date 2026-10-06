// All 109 of Kiran's QA tickets show updatedAt uniformly stamped
// 2026-05-12 (different times, same day), regardless of their real
// createdAt (spread across Nov 2025). That looks like a bulk operation
// touched updatedAt on a large swath of tickets, masking their true
// last-activity date -- checking how widespread this is across the
// whole system, and whether it's the already-known "Cloudsoft
// updatedAt bump" issue (42 tickets, already fixed) or something much
// bigger nobody's caught yet. Read-only.
//
// Usage: node check-bulk-updatedat-stamp.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: byDay } = await pool.query(`
    SELECT DATE("updatedAt") AS day, COUNT(*)::int AS cnt
    FROM issues
    GROUP BY DATE("updatedAt")
    ORDER BY cnt DESC
    LIMIT 15
  `);
  console.log('Top 15 days by ticket-updatedAt count (looking for one suspiciously large spike):');
  console.log(JSON.stringify(byDay, null, 2));

  const { rows: may12 } = await pool.query(`
    SELECT COUNT(*)::int AS cnt FROM issues WHERE DATE("updatedAt") = '2026-05-12'
  `);
  console.log(`\nTotal tickets with updatedAt on 2026-05-12: ${may12[0].cnt}`);

  // Sample a few of these to see if their createdAt is ALSO old (same
  // pattern as Kiran's), across different assignees/departments --
  // confirms whether this is a single person's tickets or genuinely
  // system-wide.
  const { rows: sample } = await pool.query(`
    SELECT COALESCE(cf_key, key) AS key, current_department, "assigneeId", "createdAt", "updatedAt"
    FROM issues
    WHERE DATE("updatedAt") = '2026-05-12'
    ORDER BY RANDOM()
    LIMIT 10
  `);
  console.log('\nRandom sample of May 12-updated tickets:');
  for (const r of sample) {
    console.log(`  ${r.key} dept=${r.current_department} assignee=${r.assigneeId} created=${r.createdAt?.toISOString?.()} updated=${r.updatedAt?.toISOString?.()}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
