// Ranadeep's complaint, restated: tickets he's "involved" in (mentioned,
// commented, previously worked) that later get updated by someone else
// don't notify him. The backend's STATUS_CHANGED/COMMENTED notifications
// only go to the ticket's CURRENT assigneeId + reporterId + admins
// (jira-pg-api.ts ~9859-9862, ~7898), and the only other path -- WATCHED --
// requires an explicit issueWatch row (nothing auto-adds a watcher on
// comment/mention). So someone who commented/was mentioned but isn't the
// current assignee/reporter gets nothing for later updates unless they
// manually click Watch. Confirms this for real: takes tickets where
// Ranadeep was mentioned/commented (already confirmed he GOT that one
// notification), checks whether he's the current assignee/reporter, and
// whether any LATER history events on those tickets produced a
// notification row for him.
//
// Read-only.
//
// Usage: node check-ranadeep-involved-tickets.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const EMAIL = 'ranadeep.muddam@cloudfuze.com';

async function main() {
  const { rows: userRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [EMAIL]);
  const userId = userRows[0]?.id;
  if (!userId) { console.log('User not found'); await pool.end(); return; }

  // Tickets where he has at least one notification row (mentioned/commented/etc).
  const { rows: keys } = await pool.query(
    `SELECT DISTINCT "issueKey" FROM notifications WHERE "userId" = $1 AND "issueKey" IS NOT NULL`,
    [userId]
  );

  for (const { issueKey } of keys) {
    const { rows: issueRows } = await pool.query(
      `SELECT id, cf_key, key, "assigneeId", "reporterId" FROM issues WHERE cf_key = $1 OR key = $1`,
      [issueKey]
    );
    if (!issueRows.length) continue;
    const issue = issueRows[0];
    const isCurrentAssignee = issue.assigneeId === userId;
    const isCurrentReporter = issue.reporterId === userId;

    const { rows: hasWatch } = await pool.query(
      `SELECT 1 FROM issue_watches WHERE "issueKey" = $1 AND "userId" = $2`,
      [issueKey, userId]
    ).catch(() => ({ rows: [] }));

    // His most recent notification for this ticket.
    const { rows: hisNotifs } = await pool.query(
      `SELECT type, "createdAt" FROM notifications WHERE "userId" = $1 AND "issueKey" = $2 ORDER BY "createdAt" DESC LIMIT 1`,
      [userId, issueKey]
    );
    const lastNotifAt = hisNotifs[0]?.createdAt;

    // Any history events on the ticket AFTER his last notification (i.e. updates that happened later).
    const { rows: laterHist } = await pool.query(
      `SELECT field, "newValue", "authorEmail", "createdAt" FROM issue_history WHERE "issueId" = $1 AND "createdAt" > $2 ORDER BY "createdAt" ASC`,
      [issue.id, lastNotifAt]
    );

    if (!laterHist.length) continue; // nothing happened after his last notification -- not a useful example

    console.log(`\n${issueKey}: currentAssignee=${isCurrentAssignee} currentReporter=${isCurrentReporter} isWatcher=${hasWatch.length > 0}`);
    console.log(`  His last notification: ${lastNotifAt.toISOString()}`);
    console.log(`  Later history events (${laterHist.length}):`);
    for (const h of laterHist.slice(0, 5)) console.log(`    [${h.createdAt.toISOString()}] ${h.field} -> ${h.newValue} (by ${h.authorEmail})`);

    const { rows: laterNotifs } = await pool.query(
      `SELECT type, title, "createdAt" FROM notifications WHERE "userId" = $1 AND "issueKey" = $2 AND "createdAt" > $3`,
      [userId, issueKey, lastNotifAt]
    );
    console.log(`  Notifications HE got after that point: ${laterNotifs.length ? JSON.stringify(laterNotifs) : 'NONE -- confirms the gap for this ticket'}`);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
