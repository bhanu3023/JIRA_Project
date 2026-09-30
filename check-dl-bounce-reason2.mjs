// email_configs holds each queue's own connected mailbox (the address
// notifications actually send FROM via sendViaTicketInbox) -- find
// Migration's and Dev's for space TESTIN, then search THAT specific
// mailbox for the real NDR bounce reason on the cfmigrationsupport/
// developmentteam DL addresses. Read-only -- only reads mail.
//
// Usage: node check-dl-bounce-reason2.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: configs } = await pool.query(
    `SELECT address, department FROM email_configs WHERE space_key = 'TESTIN' ORDER BY department`
  );
  console.log('TESTIN email_configs (queue -> connected inbox):');
  for (const c of configs) console.log(`  ${c.department}: ${c.address}`);

  const { rows: tokRows } = await pool.query(`SELECT email, tokens_json FROM oauth_tokens`);
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

  const targets = configs.filter(c => /migration|dev/i.test(c.department || ''));
  for (const cfg of targets) {
    const tokRow = tokRows.find(r => r.email.toLowerCase() === cfg.address.toLowerCase());
    if (!tokRow) { console.log(`\n[${cfg.address}] No OAuth tokens stored for this mailbox.`); continue; }
    let tokens;
    try { tokens = JSON.parse(tokRow.tokens_json); } catch { continue; }

    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret,
        refresh_token: tokens.refreshToken,
        scope: 'https://graph.microsoft.com/Mail.Read offline_access email openid profile',
      }),
    });
    if (!tokenRes.ok) { console.log(`\n[${cfg.address}] Token refresh failed: ${tokenRes.status}`); continue; }
    const { access_token } = await tokenRes.json();

    const listRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages?$filter=startswith(subject,'Undeliverable')&$top=10&$select=id,subject,receivedDateTime&$orderby=receivedDateTime desc`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    if (!listRes.ok) { console.log(`\n[${cfg.address}] List failed: ${listRes.status} ${await listRes.text().catch(()=> '')}`); continue; }
    const listData = await listRes.json();
    const msgs = listData.value || [];
    console.log(`\n[${cfg.address}] ${msgs.length} recent "Undeliverable..." message(s):`);
    for (const m of msgs) console.log(`  ${m.receivedDateTime}  ${m.subject}`);

    const match = msgs.find(m => /cfmigrationsupport|developmentteam/i.test(m.subject));
    if (match) {
      const bodyRes = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${match.id}?$select=subject,body`, { headers: { Authorization: `Bearer ${access_token}` } });
      if (bodyRes.ok) {
        const full = await bodyRes.json();
        const text = String(full.body?.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        console.log(`\n  === FULL BODY: ${full.subject} ===`);
        console.log(`  ${text.slice(0, 1200)}`);
      }
    }
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
