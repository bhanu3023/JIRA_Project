// Check whether CF-33692 is genuinely sending a notification per real
// change, or spamming duplicates/looping without real changes. Cross-
// references the notification_log table against the ticket's actual
// issue_history to see if each notification corresponds to a distinct
// real event. Read-only.
//
// Usage: node check-cf33692-notifications.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: issueRows } = await pool.query(
    `SELECT id, key, cf_key FROM issues WHERE key = 'CF-33692' OR cf_key = 'CF-33692' LIMIT 1`
  );
  if (!issueRows.length) { console.log('Not found'); await pool.end(); return; }
  const issue = issueRows[0];
  console.log('issue id:', issue.id, 'key:', issue.key, 'cf_key:', issue.cf_key);

  // notification_log doesn't carry issueId directly -- it logs subject/recipients.
  // Search by subject containing the ticket key.
  const { rows: notifs } = await pool.query(`
    SELECT id, success, subject, recipients, method, error, "createdAt"
    FROM notification_log
    WHERE subject ILIKE $1
    ORDER BY "createdAt" ASC
  `, [`%${issue.cf_key || issue.key}%`]);
  console.log(`\n${notifs.length} notification_log rows mentioning this ticket:`);
  for (const n of notifs) {
    console.log(`  [${n.createdAt?.toISOString?.() || n.createdAt}] success=${n.success} method=${n.method} subject="${n.subject}" recipients=${n.recipients} ${n.error ? `error=${n.error}` : ''}`);
  }

  const { rows: hist } = await pool.query(`
    SELECT field, "oldValue", "newValue", "authorName", "createdAt"
    FROM issue_history
    WHERE "issueId" = $1
    ORDER BY "createdAt" ASC
  `, [issue.id]);
  console.log(`\n${hist.length} real issue_history rows for this ticket:`);
  for (const h of hist) {
    console.log(`  [${h.createdAt?.toISOString?.() || h.createdAt}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" by ${h.authorName}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
