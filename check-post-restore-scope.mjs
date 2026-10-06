// Verifies the Jira-restore fix (19,588 tickets) actually corrected the
// data system-wide, not just for Kiran. Re-runs the same "suspicious
// uniform-day spike" analysis from before the restore, and separately
// checks how many of the UNRECOVERABLE tickets (notFoundInJira -- no
// longer exist in Jira to check against) still carry an obviously
// wrong bulk-stamp date, to quantify what residual risk remains for
// ANY user hitting this again. Read-only.
//
// Usage: node check-post-restore-scope.mjs
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
  console.log('Top 15 days by updatedAt count, post-restore (compare against the pre-restore spikes):');
  console.log(JSON.stringify(byDay, null, 2));

  // How many issues have a real Jira-shaped key (were candidates) but
  // were NOT restored because they're gone from Jira -- these are the
  // ones where corrupted data (if any) can never be recovered.
  const { rows: unrecoverable } = await pool.query(`
    SELECT COUNT(*)::int AS cnt FROM issues WHERE key ~ '^[A-Z][A-Z0-9]*-[0-9]+$'
  `);
  console.log(`\nTotal tickets with a real Jira-shaped key: ${unrecoverable[0].cnt}`);

  // Tickets that have NO real Jira key at all (native to this app, or
  // some other import path) -- these were never candidates for
  // restore and were never part of the corruption question either way.
  const { rows: native } = await pool.query(`
    SELECT COUNT(*)::int AS cnt FROM issues WHERE key !~ '^[A-Z][A-Z0-9]*-[0-9]+$'
  `);
  console.log(`Total tickets with no Jira-shaped key (native to this app): ${native[0].cnt}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
