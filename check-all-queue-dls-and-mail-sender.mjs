// User has now added DLs across several queues (Dev shown with
// developmentteam@cloudfuze.com). Before saying yes/no on "will
// notifications actually go out," checking two things: (1) every queue
// across every space that currently has a notifyEmails DL configured, and
// (2) whether the underlying mail-sending path
// (notification-service.ts's sendNotification) actually has a working
// sender configured at all -- a correctly-saved DL address does nothing
// if there's no way to send mail in the first place.
//
// Read-only.
//
// Usage: node check-all-queue-dls-and-mail-sender.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: allSpaces } = await pool.query(
    `SELECT sp.key, sp.name, cq.queues FROM spaces sp LEFT JOIN custom_queues cq ON cq.space_key = sp.key ORDER BY sp.key`
  );
  console.log('Every queue with a notify DL configured, across every space:');
  let anyFound = false;
  for (const s of allSpaces) {
    for (const q of s.queues || []) {
      if (Array.isArray(q.notifyEmails) && q.notifyEmails.length) {
        anyFound = true;
        console.log(`  ${s.key} / ${q.name}: ${JSON.stringify(q.notifyEmails)}`);
      }
    }
  }
  if (!anyFound) console.log('  NONE found');

  console.log('\n--- Mail-sending infrastructure check ---');
  console.log(`NODE_ENV: ${process.env.NODE_ENV || '(not set)'}`);
  console.log(`DEFAULT_NOTIFICATION_SENDER: ${process.env.DEFAULT_NOTIFICATION_SENDER ? 'set' : 'NOT SET'}`);
  console.log(`SMTP_HOST: ${process.env.SMTP_HOST ? 'set' : 'NOT SET'}`);
  console.log(`SMTP_USER: ${process.env.SMTP_USER ? 'set' : 'NOT SET'}`);
  console.log(`SMTP_PASS: ${process.env.SMTP_PASS ? 'set (hidden)' : 'NOT SET'}`);

  // Connected mailboxes that could serve as a Graph-based sender
  const { rows: emailConfigs } = await pool.query(
    `SELECT email, provider, department, status FROM email_configs ORDER BY email`
  ).catch(() => ({ rows: [] }));
  console.log(`\nConnected email accounts (email_configs table): ${emailConfigs.length}`);
  for (const e of emailConfigs) console.log(`  ${e.email}  provider=${e.provider}  dept=${e.department || '(none)'}  status=${e.status}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
