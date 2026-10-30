// Resets updatedAt back to each ticket's real last-activity timestamp
// (createdAt, resolvedAt, last issue_history row, last comment, last
// attachment, or last worklog entry -- whichever is latest) for every
// ticket where the current updatedAt sits more than 1 hour after that,
// with nothing to explain the gap. This undoes the historical damage from
// the Jira sync's unconditional updatedAt-copy bug (just fixed in
// refreshSyncProjectIssue/refreshCfitsIssue) going forward.
//
// Defaults to DRY RUN. Pass --apply to actually write the corrections.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

const LAST_REAL_CTE = `
  WITH last_real_activity AS (
    SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i."updatedAt",
           GREATEST(
             i."createdAt",
             COALESCE(i."resolvedAt", i."createdAt"),
             COALESCE((SELECT MAX(h."createdAt") FROM issue_history h WHERE h."issueId" = i.id), i."createdAt"),
             COALESCE((SELECT MAX(GREATEST(c."createdAt", c."updatedAt")) FROM comments c WHERE c."issueId" = i.id), i."createdAt"),
             COALESCE((SELECT MAX(a."createdAt") FROM attachments a WHERE a."issueId" = i.id), i."createdAt"),
             COALESCE((SELECT MAX(w."createdAt") FROM issue_worklogs w WHERE w."issueId" = i.id), i."createdAt")
           ) AS last_real
    FROM issues i
  )
`;

async function main() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      ${LAST_REAL_CTE}
      SELECT id, key, "updatedAt" AS old_updated_at, last_real AS new_updated_at
      FROM last_real_activity
      WHERE "updatedAt" > last_real + INTERVAL '1 hour'
    `);
    console.log(`Tickets to correct: ${rows.length}`);
    console.log('\nSample (first 10):');
    for (const r of rows.slice(0, 10)) {
      console.log(` - ${r.key}: ${r.old_updated_at.toISOString()} -> ${r.new_updated_at.toISOString()}`);
    }

    if (!APPLY) {
      console.log('\nDRY RUN ONLY -- no rows changed. Re-run with --apply to actually update.');
      return;
    }

    await client.query('BEGIN');
    const { rowCount } = await client.query(`
      ${LAST_REAL_CTE}
      UPDATE issues i SET "updatedAt" = lra.last_real
      FROM last_real_activity lra
      WHERE i.id = lra.id AND lra."updatedAt" > lra.last_real + INTERVAL '1 hour'
    `);
    await client.query('COMMIT');
    console.log(`\nCorrected ${rowCount} tickets' updatedAt.`);

    const { rows: remaining } = await client.query(`
      ${LAST_REAL_CTE}
      SELECT COUNT(*) FROM last_real_activity WHERE "updatedAt" > last_real + INTERVAL '1 hour'
    `);
    console.log(`Remaining phantom-updatedAt tickets: ${remaining[0].count}`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
