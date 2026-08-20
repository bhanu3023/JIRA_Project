/**
 * fix-dev-updated-at-from-history.mjs
 *
 * Every migrated Dev-board ticket (L2B-* / L3B-*, spaceKey L2BOARD/L3BOARD)
 * ended up with the exact same issues.updatedAt (the day a later bulk sync
 * script ran) instead of its real last-activity time from Jira. Root cause:
 * Issue.updatedAt is a Prisma @updatedAt field, so any prisma.issue.update()
 * that doesn't explicitly pass `updatedAt` in `data` gets it silently reset
 * to "now" -- sync-all-assignees.mjs and sync-all-descriptions.mjs both do
 * exactly that across every L2B/L3B ticket, stomping the real Jira-sourced
 * updatedAt the original migration (migrate-l2b-board.mjs /
 * migrate-l3b-board.mjs) had correctly set.
 *
 * The real "last updated" time for each ticket still exists in
 * issue_history (createdAt column = when that field-change actually
 * happened in Jira, preserved verbatim by the sync-history* scripts). This
 * restores issues.updatedAt from there:
 *
 *   correct updatedAt = MAX(issue_history.createdAt) for that issue,
 *                        falling back to issue.createdAt if it has no
 *                        history rows at all (never touched -> nothing to
 *                        restore, createdAt is the best available answer).
 *
 * For an already-resolved ticket this naturally lands on its real
 * resolved-status-change time, since that's the last thing that happened
 * to it in Jira -- no separate "find the Resolved transition" logic needed.
 *
 * Only rewrites a row when the current updatedAt is off by more than an
 * hour from the correct value (same mismatch threshold already used by
 * fix-worked-on-closed-timestamps.mjs elsewhere in this repo) -- so a
 * ticket that's already correct, or was only off by clock-skew seconds, is
 * left alone.
 *
 * SAFE BY DEFAULT: dry run unless DRY_RUN=false is passed explicitly.
 *
 * Env vars:
 *   DATABASE_URL - optional, defaults to the local dev DB
 *   DRY_RUN      - default 'true'; pass 'false' to actually write
 *
 * Run: node fix-dev-updated-at-from-history.mjs
 * Apply for real: DRY_RUN=false node fix-dev-updated-at-from-history.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const DRY_RUN = process.env.DRY_RUN !== 'false';
const MISMATCH_THRESHOLD_SECONDS = 3600;

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, i.key, i."updatedAt" AS current_updated_at, i."createdAt" AS issue_created_at,
           h.last_history_at
    FROM issues i
    LEFT JOIN (
      SELECT "issueId", MAX("createdAt") AS last_history_at
      FROM issue_history
      GROUP BY "issueId"
    ) h ON h."issueId" = i.id
    WHERE i.key LIKE 'L2B-%' OR i.key LIKE 'L3B-%'
  `);

  let checked = 0;
  let toFix = 0;
  let noHistory = 0;
  const sample = [];

  for (const row of rows) {
    checked++;
    const correct = row.last_history_at || row.issue_created_at;
    if (!row.last_history_at) noHistory++;

    const diffSeconds = Math.abs((new Date(row.current_updated_at).getTime() - new Date(correct).getTime()) / 1000);
    if (diffSeconds <= MISMATCH_THRESHOLD_SECONDS) continue;

    toFix++;
    if (sample.length < 20) {
      sample.push({ key: row.key, from: row.current_updated_at, to: correct, source: row.last_history_at ? 'issue_history' : 'issue.createdAt (no history rows)' });
    }

    if (!DRY_RUN) {
      await pool.query(`UPDATE issues SET "updatedAt" = $1 WHERE id = $2`, [correct, row.id]);
    }
  }

  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Checked ${checked} Dev-board ticket(s) (L2B-*/L3B-*).`);
  console.log(`${DRY_RUN ? '[DRY RUN] Would fix' : 'Fixed'} ${toFix} ticket(s) whose updatedAt was off by more than ${MISMATCH_THRESHOLD_SECONDS / 3600}h.`);
  console.log(`${noHistory} ticket(s) have no issue_history rows at all (fell back to their own createdAt).`);
  console.log('Sample of changes (first 20):');
  console.log(JSON.stringify(sample, null, 2));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
