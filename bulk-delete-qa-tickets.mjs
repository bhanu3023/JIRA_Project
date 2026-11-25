// Delete 25 specific tickets per explicit admin request -- direct-DB version
// (the token-based HTTP version needs a personal API token, which was
// friction; this replicates the exact same trash-then-delete logic the real
// DELETE /api/issues/:key endpoint uses, verified against
// src/lib/jira-pg-api.ts's issueKeyMatch DELETE handler and the Prisma
// schema's onDelete: Cascade on Comment/Attachment/IssueHistory, and the raw
// issue_worklogs table's own "ON DELETE CASCADE" FK -- so a plain
// `DELETE FROM issues` cascades exactly the way db.issue.delete() does.
//
// Snapshots the ticket (+ comments/attachments/history) into deleted_issues
// before the real delete, so it's restorable later from the app's own
// Settings > Deleted Issues trash if ever needed. Dry-run by default;
// --apply to write. Acting-admin identity comes from ADMIN_EMAIL env var.
import pg from 'pg';
import crypto from 'crypto';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
if (!ADMIN_EMAIL) {
  console.log('Set ADMIN_EMAIL=<your email> before running this script.');
  process.exit(1);
}

const KEYS = [
  'CF-9889', 'CF-10256', 'CF-10426', 'CF-14614', 'CF-14921', 'CF-14951', 'CF-14986',
  'CF-18386', 'CF-19061', 'CF-19328', 'CF-19362', 'CF-19369', 'CF-19862', 'CF-20168',
  'CF-22183', 'CF-24400', 'CF-24430', 'CF-24990', 'CF-25059', 'CF-25121', 'CF-25171',
  'CF-25172', 'CF-25292', 'CF-27197', 'CF-30003',
];

async function main() {
  const { rows: adminRows } = await pool.query(
    `SELECT id, "firstName", "lastName", email FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [ADMIN_EMAIL],
  );
  if (!adminRows.length) {
    console.log(`Admin user not found for ${ADMIN_EMAIL} -- aborting.`);
    await pool.end();
    process.exit(1);
  }
  const admin = adminRows[0];
  const adminName = `${admin.firstName || ''} ${admin.lastName || ''}`.trim() || admin.email;
  console.log(`Acting as: ${adminName} <${admin.email}> (${admin.id})\n`);

  for (const key of KEYS) {
    const { rows } = await pool.query(
      `SELECT i.*, sp.key AS space_key FROM issues i LEFT JOIN spaces sp ON sp.id = i."spaceId"
       WHERE i.key = $1 OR i.cf_key = $1`,
      [key],
    );
    if (!rows.length) {
      console.log(`${key}: NOT FOUND -- skipping`);
      continue;
    }
    const issueRow = rows[0];
    const displayKey = issueRow.cf_key || issueRow.key;

    if (!APPLY) {
      console.log(`[dry-run] would DELETE ${displayKey}: "${issueRow.summary}"`);
      continue;
    }

    const [comments, attachments, history] = await Promise.all([
      pool.query(`SELECT * FROM comments WHERE "issueId" = $1`, [issueRow.id]),
      pool.query(`SELECT * FROM attachments WHERE "issueId" = $1`, [issueRow.id]),
      pool.query(`SELECT * FROM issue_history WHERE "issueId" = $1`, [issueRow.id]),
    ]);

    try {
      await pool.query(
        `INSERT INTO deleted_issues (id, key, cf_key, space_key, summary, data, deleted_by_id, deleted_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          crypto.randomUUID(), issueRow.key, issueRow.cf_key, issueRow.space_key, issueRow.summary,
          JSON.stringify({ issue: issueRow, comments: comments.rows, attachments: attachments.rows, history: history.rows }),
          admin.id, adminName,
        ],
      );
    } catch (e) {
      console.error(`${displayKey}: FAILED to snapshot to trash -- not deleting. Error:`, e.message);
      continue;
    }

    await pool.query(`DELETE FROM issues WHERE id = $1`, [issueRow.id]);
    await pool.query(`UPDATE spaces SET "issueCount" = GREATEST("issueCount" - 1, 0) WHERE id = $1`, [issueRow.spaceId]);
    console.log(`${displayKey}: DELETED ("${issueRow.summary}") -- snapshot saved to deleted_issues, restorable from Settings > Deleted Issues.`);
  }

  console.log(APPLY ? '\nDone.' : '\nDry run only -- re-run with --apply to actually delete.');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
