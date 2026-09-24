// User reports create/comment/status-change notifications aren't working for
// IT Administration (IA) and SAT_Board (SB), unlike other spaces. The
// recipient logic in jira-pg-api.ts (notifyUsers([assignee, reporter,
// ...leads, ...admins], ...)) doesn't look space-gated on its face, so
// checking real data: for the most recent tickets in IA/SB vs. a known-good
// space (TESTIN), do CREATED/COMMENTED/STATUS_CHANGED notification rows
// actually exist? Also checking whether these tickets even HAVE an
// assignee/reporter to notify, since notifyUsers silently no-ops for null
// recipients (not a bug, just nobody to tell).
//
// Read-only.
//
// Usage: node check-ia-sb-notifications.mjs
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  for (const spaceKey of ['IA', 'SB', 'TESTIN']) {
    console.log(`\n\n========== ${spaceKey} ==========`);
    const { rows: issues } = await pool.query(
      `SELECT i.id, COALESCE(i.cf_key, i.key) AS display_key, i."assigneeId", i."reporterId",
              i."createdAt", a.email AS assignee_email, r.email AS reporter_email
       FROM issues i JOIN spaces sp ON sp.id = i."spaceId"
       LEFT JOIN users a ON a.id = i."assigneeId"
       LEFT JOIN users r ON r.id = i."reporterId"
       WHERE sp.key = $1 ORDER BY i."createdAt" DESC LIMIT 8`,
      [spaceKey]
    );
    for (const iss of issues) {
      const { rows: notifs } = await pool.query(
        `SELECT type, "userId", "createdAt" FROM notifications WHERE "issueKey" = $1 ORDER BY "createdAt" ASC`,
        [iss.display_key]
      );
      console.log(`\n  ${iss.display_key}  created=${iss.createdAt.toISOString()}  assignee=${iss.assignee_email || 'NONE'}  reporter=${iss.reporter_email || 'NONE'}`);
      console.log(`    notifications: ${notifs.length}`, notifs.map(n => n.type).join(', ') || '(none)');
      const { rows: comments } = await pool.query(`SELECT COUNT(*) FROM comments WHERE "issueId" = $1`, [iss.id]);
      const { rows: statusChanges } = await pool.query(
        `SELECT COUNT(*) FROM issue_history WHERE "issueId" = $1 AND field = 'status'`, [iss.id]
      );
      console.log(`    comments on ticket: ${comments[0].count}   status-change history rows: ${statusChanges[0].count}`);
    }
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
