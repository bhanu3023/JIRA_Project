// Bulk-resolve 25 specific QA tickets per explicit admin request.
// User confirmed: leave assignee as-is (do not assign anyone), log a
// "Reviewed and resolved" worklog on each (QA requires a worklog on every
// status change -- this keeps that audit trail honest), then flip status to
// the space's "Resolved" (done-category) status and set resolvedAt.
//
// This bypasses the UI's own "must have an assignee before Resolved" gate on
// purpose (explicit admin instruction), going straight to the DB rather than
// the HTTP API -- so unlike a normal resolve, this will NOT trigger
// resolution notification emails or SLA-snapshot freezing. Dry-run by
// default; pass --apply to write.
import pg from 'pg';
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

  const { rows } = await pool.query(
    `SELECT i.id, i.key, i.cf_key, i."spaceId", i."statusId", i.current_department, s.name AS status_name, s.category AS status_category
     FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
     WHERE i.key = ANY($1::text[]) OR i.cf_key = ANY($1::text[])`,
    [KEYS],
  );
  const found = new Set(rows.map((r) => r.cf_key || r.key));
  for (const k of KEYS) if (!found.has(k)) console.log(`NOT FOUND, skipping: ${k}`);

  for (const r of rows) {
    const key = r.cf_key || r.key;
    if (r.status_category === 'done') {
      console.log(`${key}: already in a done-category status ("${r.status_name}") -- skipping status change, but will still log the worklog.`);
    }

    const { rows: resolvedStatusRows } = await pool.query(
      `SELECT id, name FROM statuses WHERE "spaceId" = $1 AND category = 'done' AND lower(name) = 'resolved' LIMIT 1`,
      [r.spaceId],
    );
    const resolvedStatus = resolvedStatusRows[0];
    if (!resolvedStatus && r.status_category !== 'done') {
      console.log(`${key}: no "Resolved" done-category status found for space ${r.spaceId} -- skipping.`);
      continue;
    }

    const worklogId = `wl_bulk_${r.id}_${Date.now()}`;
    console.log(
      `${key}: ${APPLY ? 'LOGGING' : '[dry-run] would log'} worklog (dept=QA, 5min, "Reviewed and resolved")` +
      (r.status_category !== 'done' ? ` and set status "${r.status_name}" -> "${resolvedStatus.name}", resolvedAt=now` : ''),
    );

    if (!APPLY) continue;

    await pool.query(
      `INSERT INTO issue_worklogs (id, "issueId", department, "timeSpentMinutes", description, "workDate", "authorId", "authorName", "authorEmail", "createdAt")
       VALUES ($1, $2, 'QA', 5, 'Reviewed and resolved', NOW(), $3, $4, $5, NOW())`,
      [worklogId, r.id, admin.id, adminName, admin.email],
    );

    if (r.status_category !== 'done') {
      await pool.query(
        `UPDATE issues SET "statusId" = $1, "resolvedAt" = NOW(), "updatedAt" = NOW() WHERE id = $2`,
        [resolvedStatus.id, r.id],
      );
      await pool.query(
        `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt")
         VALUES ($1, $2, 'status', $3, $4, $5, $6, NOW())`,
        [`ih_bulk_${r.id}_${Date.now()}`, r.id, r.status_name, resolvedStatus.name, adminName, admin.email],
      );
    }
  }

  console.log(APPLY ? '\nApplied.' : '\nDry run only -- re-run with --apply to write.');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
