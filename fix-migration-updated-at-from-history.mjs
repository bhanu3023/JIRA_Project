/**
 * fix-migration-updated-at-from-history.mjs
 *
 * Same bug and same fix as fix-dev-updated-at-from-history.mjs, applied to
 * the Migration board instead of Dev.
 *
 * Root cause: issues.updatedAt is a Prisma @updatedAt field, so any
 * prisma.issue.update() that doesn't explicitly pass `updatedAt` gets it
 * silently reset to "now". sync-all-assignees.mjs (BOARD_MAP.L1BOAR) and
 * sync-all-descriptions.mjs (BOARD_MAP prefix 'L1BOAR') both cover the
 * Migration board (spaceKey/key prefix L1BOAR) the same way they covered
 * Dev's L2B/L3B, and neither passed updatedAt -- both scripts are now
 * fixed to preserve it going forward, but every Migration ticket they
 * already touched still has the wrong (bulk-sync-run-date) updatedAt.
 *
 * Restores issues.updatedAt for every L1BOAR-* ticket from issue_history
 * (the real Jira-timestamped last change for that ticket -- naturally the
 * resolved-status time for a resolved ticket, since that's the last thing
 * that happened to it), falling back to the issue's own createdAt when it
 * has no history rows at all.
 *
 * Only rewrites a row when the current updatedAt is off by more than an
 * hour from the correct value, so an already-correct ticket is left alone.
 *
 * SAFE BY DEFAULT: dry run unless DRY_RUN=false is passed explicitly.
 *
 * Env vars:
 *   DATABASE_URL - optional, defaults to the local dev DB
 *   DRY_RUN      - default 'true'; pass 'false' to actually write
 *
 * Run: node fix-migration-updated-at-from-history.mjs
 * Apply for real: DRY_RUN=false node fix-migration-updated-at-from-history.mjs
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
    WHERE i.key LIKE 'L1BOAR-%'
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

  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Checked ${checked} Migration-board ticket(s) (L1BOAR-*).`);
  console.log(`${DRY_RUN ? '[DRY RUN] Would fix' : 'Fixed'} ${toFix} ticket(s) whose updatedAt was off by more than ${MISMATCH_THRESHOLD_SECONDS / 3600}h.`);
  console.log(`${noHistory} ticket(s) have no issue_history rows at all (fell back to their own createdAt).`);
  console.log('Sample of changes (first 20):');
  console.log(JSON.stringify(sample, null, 2));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
