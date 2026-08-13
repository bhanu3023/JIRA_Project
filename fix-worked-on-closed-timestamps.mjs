/**
 * fix-worked-on-closed-timestamps.mjs
 *
 * backfill-worked-on-for-resolved.mjs (run earlier this session) inserted
 * ~16,710 user_worked_on_tickets rows with reason='closed' but its INSERT
 * omitted worked_at, so every one of those rows fell back to the column's
 * DEFAULT NOW() -- meaning they all got stamped with the moment the backfill
 * script ran, not the ticket's actual historical resolution date. Effect:
 * the per-queue Summary's "Per user" range filter (which buckets by
 * worked_at) looks frozen when switching between 7d/30d/90d, since nearly
 * all backfilled rows cluster on that one artificial date.
 *
 * This is a one-time correction: for every reason='closed' row whose
 * worked_at is way off from its issue's own updated/created date (i.e. the
 * telltale sign of the NOW()-default bug, not a real live close), reset
 * worked_at to COALESCE(issue.updatedAt, issue.createdAt).
 *
 * Safe: only touches worked_at, only for rows already off by more than an
 * hour from the ticket's own dates, only reason='closed'. Rows correctly
 * recorded by the live resolve flow (worked_at ~= updatedAt already) are
 * left untouched since they won't meet the mismatch threshold.
 *
 * Env vars:
 *   DATABASE_URL - optional, defaults to the local dev DB
 *   DRY_RUN      - default 'true'; pass 'false' to actually update
 *
 * Run: node fix-worked-on-closed-timestamps.mjs
 * Apply for real: DRY_RUN=false node fix-worked-on-closed-timestamps.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const DRY_RUN = process.env.DRY_RUN !== 'false';

async function main() {
  const rows = await pool.query(`
    SELECT w.user_id, w.issue_id, w.dept, w.worked_at,
           COALESCE(i."updatedAt", i."createdAt") AS correct_worked_at
    FROM user_worked_on_tickets w
    JOIN issues i ON i.id = w.issue_id
    WHERE w.reason = 'closed'
      AND ABS(EXTRACT(EPOCH FROM (w.worked_at - COALESCE(i."updatedAt", i."createdAt")))) > 3600
  `);
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Found ${rows.rows.length} 'closed' worked-on rows with a mis-stamped worked_at.`);

  if (rows.rows.length) {
    console.log('Sample (first 5):');
    for (const r of rows.rows.slice(0, 5)) {
      console.log(`  issue=${r.issue_id} user=${r.user_id} worked_at=${r.worked_at.toISOString()} -> ${r.correct_worked_at.toISOString()}`);
    }
  }

  if (!DRY_RUN) {
    for (const r of rows.rows) {
      await pool.query(
        `UPDATE user_worked_on_tickets SET worked_at = $1 WHERE user_id = $2 AND issue_id = $3 AND dept = $4`,
        [r.correct_worked_at, r.user_id, r.issue_id, r.dept]
      );
    }
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Done. ${rows.rows.length} rows ${DRY_RUN ? 'would be' : 'were'} corrected.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
