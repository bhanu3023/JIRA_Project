// notifyStatusChanged (and comment/mention notifications) look up the
// ticket's OWN space's registered inbox via email_configs and pass it as
// sendNotification's `fromEmail` -- which is tried BEFORE
// DEFAULT_NOTIFICATION_SENDER/EMAIL_USER, so it wins regardless of the .env
// changes already made. TESTIN (the main CloudFuze Board -- Dev/QA/Infra/
// Migration/Pre-Sales) and INFRA are both registered to no-reply@cloudfuze.info,
// which is why virtually every ticket notification email goes out under that
// address. Per explicit confirmation that leo@fuzebot.io is also a properly
// monitored inbox (so reply-to-ticket threading won't break), switches both
// rows to leo@fuzebot.io.
//
// Usage: node fix-email-configs-testin-infra.mjs [--apply]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(
    `SELECT space_key, address FROM email_configs WHERE LOWER(address) = 'no-reply@cloudfuze.info'`
  );
  console.log('Rows currently registered to no-reply@cloudfuze.info:');
  console.log(JSON.stringify(rows, null, 2));

  if (APPLY) {
    const res = await pool.query(
      `UPDATE email_configs SET address = 'leo@fuzebot.io' WHERE LOWER(address) = 'no-reply@cloudfuze.info'`
    );
    console.log(`\nUpdated ${res.rowCount} row(s) to leo@fuzebot.io.`);
  } else {
    console.log(`\n(dry run -- would update ${rows.length} row(s) to leo@fuzebot.io. Re-run with --apply.)`);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
