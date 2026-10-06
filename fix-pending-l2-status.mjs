// Moves every ticket still on the removed "Pending with L2" status
// (status_pending_with_l2) to this space's "In Progress" status, and
// logs an issue_history row for each so there's an audit trail. Confirmed
// via check-pending-l2-status.mjs: no queue config currently offers
// "Pending with L2" as a selectable option, yet 10 tickets (7 Pre-Sales,
// 1 Infra, 1 Migration/CF-32149, 1 QA) are still set to it. Dry-run by
// default; pass --apply to write.
//
// Usage: node fix-pending-l2-status.mjs [--apply]
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

function rid() {
  return 'hist_' + Math.random().toString(36).slice(2, 12);
}

async function main() {
  const { rows: pending } = await pool.query(`
    SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i."spaceId", i.current_department
    FROM issues i
    WHERE i."statusId" = 'status_pending_with_l2'
  `);
  console.log(`Found ${pending.length} tickets on "Pending with L2":`, pending.map(p => `${p.key} (${p.current_department})`).join(', '));

  // Resolve each ticket's own space's "In Progress" status id (status ids
  // can differ per space even for the same name).
  const spaceIds = [...new Set(pending.map(p => p.spaceId))];
  const { rows: inProgressRows } = await pool.query(
    `SELECT id, "spaceId" FROM statuses WHERE "spaceId" = ANY($1::text[]) AND LOWER(name) = 'in progress'`,
    [spaceIds]
  );
  const inProgressBySpace = new Map(inProgressRows.map(r => [r.spaceId, r.id]));
  console.log('In Progress status id per space:', Object.fromEntries(inProgressBySpace));

  const missingSpace = spaceIds.filter(sid => !inProgressBySpace.has(sid));
  if (missingSpace.length) {
    console.log(`WARNING: no "In Progress" status found for space(s) ${missingSpace.join(', ')} -- those tickets will be skipped.`);
  }

  if (!APPLY) {
    console.log('\nDry run only -- re-run with --apply to write these changes.');
    await pool.end();
    return;
  }

  for (const p of pending) {
    const newStatusId = inProgressBySpace.get(p.spaceId);
    if (!newStatusId) { console.log(`Skipping ${p.key} -- no In Progress status for its space`); continue; }
    await pool.query(`UPDATE issues SET "statusId" = $1, "updatedAt" = NOW() WHERE id = $2`, [newStatusId, p.id]);
    await pool.query(
      `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt")
       VALUES ($1, $2, 'status', $3, $4, $5, $6, NOW())`,
      [rid(), p.id, 'Pending with L2', 'In Progress', 'System (status cleanup)', 'system@neutara']
    );
    console.log(`${p.key}: Pending with L2 -> In Progress`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
