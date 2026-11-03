// Read-only: confirm the self-mail-loop theory -- leo@fuzebot.io is both (a)
// the FROM_EMAIL env fallback used to send "New KB Article" notification
// emails, and (b) a monitored support inbox (email_configs) whose incoming
// mail creates new CUSTM tickets. If KB-publish notifications are sent TO
// every active user including leo@fuzebot.io's own guest account, and that
// same address is the monitored inbox, each KB publish mails itself and
// creates a new ticket out of its own notification.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: configs } = await pool.query(`SELECT space_key, address, auto_reply FROM email_configs WHERE address ILIKE '%fuzebot%'`);
  console.log('email_configs rows matching fuzebot:', JSON.stringify(configs, null, 2));

  // Is leo@fuzebot.io's own guest account counted as an "active user" that
  // would receive a broadcast notification (announcePublished's recipient
  // list is literally db.user.findMany({ where: { isActive: true } }))?
  const { rows: activeCount } = await pool.query(`SELECT COUNT(*) FROM users WHERE "isActive" = true`);
  const { rows: leoActive } = await pool.query(`SELECT id, email, "isActive", role FROM users WHERE id = 'guest_leo_fuzebot_io'`);
  console.log('\nTotal active users (all would receive a KB-published broadcast):', activeCount[0].count);
  console.log('leo@fuzebot.io account:', leoActive[0]);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
