// notifyIssueCreated/Commented/etc pass fromEmail = getInboxEmailForSpace()
// (the space's OWN connected mailbox, via email_configs) into
// sendNotification, which tries THAT mailbox's Graph/OAuth connection FIRST.
// If a space has no email_configs row, that first path is skipped and it
// falls through to DEFAULT_NOTIFICATION_SENDER -> global SMTP -> any other
// OAuth account -- a much less reliable chain (comments in the code mention
// SMTP being actively broken for Microsoft 365 tenants). Checking whether
// IA/SB simply have no connected inbox configured, unlike spaces where email
// notifications are known to work.
//
// Read-only.
//
// Usage: node check-email-configs-per-space.mjs
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT space_key, address, provider, created_at FROM email_configs ORDER BY space_key`);
  console.log('email_configs rows:');
  for (const r of rows) console.log(` `, r);

  console.log(`\nDEFAULT_NOTIFICATION_SENDER env: ${process.env.DEFAULT_NOTIFICATION_SENDER || '(not set)'}`);
  console.log(`SMTP_HOST env: ${process.env.SMTP_HOST || '(not set, defaults to smtp.office365.com)'}`);
  console.log(`EMAIL_USER env: ${process.env.EMAIL_USER || '(not set)'}`);

  // Any connected OAuth accounts at all (used as the last-resort fallback)?
  try {
    const { rows: oauth } = await pool.query(`SELECT email, provider, "createdAt" FROM email_accounts ORDER BY "createdAt" DESC LIMIT 10`);
    console.log(`\nConnected OAuth email accounts (${oauth.length} shown, most recent first):`);
    for (const o of oauth) console.log(' ', o);
  } catch (e) { console.log('\n(could not query email_accounts table:', e.message, ')'); }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
