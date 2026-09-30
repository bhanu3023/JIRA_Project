// EVERY notification from no-reply@cloudfuze.info is bouncing, not just
// the DL ones -- assigned-to, status-changed, comment-reply, all of them.
// That points at a sender-side problem (SPF/DKIM/DMARC, mailbox not
// licensed to send, etc.), not "the DL address doesn't exist". Fetching
// the FULL NDR body to get the real reason. Read-only.
//
// Usage: node check-noreply-bounce-body.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: tokRows } = await pool.query(`SELECT tokens_json FROM oauth_tokens WHERE email = 'no-reply@cloudfuze.info'`);
  if (!tokRows.length) { console.log('No tokens for no-reply@cloudfuze.info'); await pool.end(); return; }
  const tokens = JSON.parse(tokRows[0].tokens_json);

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
      scope: 'https://graph.microsoft.com/Mail.Read offline_access email openid profile',
    }),
  });
  const { access_token } = await tokenRes.json();

  const listRes = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?$search="subject:Undeliverable"&$top=1&$select=id,subject`,
    { headers: { Authorization: `Bearer ${access_token}`, ConsistencyLevel: 'eventual' } }
  );
  const listData = await listRes.json();
  const m = (listData.value || [])[0];
  if (!m) { console.log('No NDR found'); await pool.end(); return; }

  const bodyRes = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${m.id}?$select=subject,body,sender,from`, { headers: { Authorization: `Bearer ${access_token}` } });
  const full = await bodyRes.json();
  const text = String(full.body?.content || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g,' ').replace(/\s+/g, ' ').trim();
  console.log(`Subject: ${full.subject}`);
  console.log(`\nFull body:\n${text}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
