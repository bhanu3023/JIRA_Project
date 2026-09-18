// Ranadeep reports not receiving notifications. In-app notifications go
// through createNotification() -> db.notification.create(), gated per-type
// by userWantsNotif() reading a notificationPreference row (defaulting to
// all-true if none exists or the read throws). Checks: does his user row
// exist/is active, does he have a notificationPreference row (and if so,
// are the relevant flags actually on), how many notification rows exist for
// him and how recent, and whether he's had any assignment/comment/mention
// activity recently that SHOULD have produced one.
//
// Read-only.
//
// Usage: node check-ranadeep-notifications.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const EMAIL = 'ranadeep.muddam@cloudfuze.com';

async function main() {
  const { rows: userRows } = await pool.query(
    `SELECT id, email, "isActive", role, "firstName", "lastName" FROM users WHERE email = $1`,
    [EMAIL]
  );
  if (!userRows.length) { console.log(`No user row found for ${EMAIL}`); await pool.end(); return; }
  const user = userRows[0];
  console.log('=== User row ===');
  console.log(JSON.stringify(user, null, 2));

  console.log('\n=== Notification preference row ===');
  const { rows: prefRows } = await pool.query(
    `SELECT * FROM notification_preferences WHERE "userId" = $1`,
    [user.id]
  );
  console.log(prefRows.length ? JSON.stringify(prefRows[0], null, 2) : '(no row -- defaults to all notification types ON)');

  console.log('\n=== Recent notification rows for this user (last 20) ===');
  const { rows: notifRows } = await pool.query(
    `SELECT id, type, title, "issueKey", "isRead", "createdAt" FROM notifications WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 20`,
    [user.id]
  ).catch((e) => { console.log(`  query failed: ${e.message}`); return { rows: [] }; });
  for (const n of notifRows) console.log(`  [${n.createdAt.toISOString()}] ${n.type} - "${n.title}" (issue ${n.issueKey}, read=${n.isRead})`);
  if (!notifRows.length) console.log('  (none found at all)');

  console.log('\n=== Tickets currently assigned to him ===');
  const { rows: assignedRows } = await pool.query(
    `SELECT cf_key, key, "updatedAt" FROM issues WHERE "assigneeId" = $1 ORDER BY "updatedAt" DESC LIMIT 10`,
    [user.id]
  );
  for (const r of assignedRows) console.log(`  ${r.cf_key || r.key} (updated ${r.updatedAt.toISOString()})`);
  if (!assignedRows.length) console.log('  (none currently assigned to him)');

  console.log('\n=== Recent issue_history rows where he is the author (last 10, any field) ===');
  const { rows: histRows } = await pool.query(
    `SELECT ih."issueId", i.cf_key, ih.field, ih."newValue", ih."createdAt"
     FROM issue_history ih JOIN issues i ON i.id = ih."issueId"
     WHERE ih."authorEmail" = $1 ORDER BY ih."createdAt" DESC LIMIT 10`,
    [EMAIL]
  ).catch((e) => { console.log(`  query failed: ${e.message}`); return { rows: [] }; });
  for (const h of histRows) console.log(`  [${h.createdAt.toISOString()}] ${h.cf_key} ${h.field} -> ${h.newValue}`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
