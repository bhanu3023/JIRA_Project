// Checks the sender mailbox's OWN inbox for bounce/NDR messages -- a jump
// from 3 to 686 unread items strongly suggests a flood of non-delivery
// reports, which would explain exactly why real notifications aren't
// reaching recipients even though Graph accepts every send.
//
// Usage: node test-check-sender-inbox.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SENDER = 'no-reply@cloudfuze.info';

async function main() {
  const { rows } = await pool.query(`SELECT tokens_json FROM oauth_tokens WHERE email = $1`, [SENDER]);
  const tokens = JSON.parse(rows[0].tokens_json);
  const refreshRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
      scope: 'https://graph.microsoft.com/Mail.Read offline_access',
    }),
  });
  const accessToken = (await refreshRes.json()).access_token;
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=15&$orderby=receivedDateTime desc&$select=subject,from,receivedDateTime,bodyPreview`,
    { headers: authHeader }
  );
  const data = await res.json();
  if (!data.value?.length) { console.log('Inbox is empty or unreadable.'); await pool.end(); return; }
  for (const msg of data.value) {
    console.log(`[${msg.receivedDateTime}] FROM: ${msg.from?.emailAddress?.address}`);
    console.log(`  Subject: ${msg.subject}`);
    console.log(`  Preview: ${(msg.bodyPreview || '').slice(0, 200).replace(/\n/g, ' ')}`);
    console.log('');
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error('Unexpected error:', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
