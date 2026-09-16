// Lists the most recent messages directly in a mailbox's Junk Email folder
// by folder id, bypassing Graph's $search entirely -- $search has already
// been confirmed unreliable for Junk Email specifically (it missed a message
// independently confirmed present via the Outlook UI). A direct folder
// listing has no such indexing gap.
//
// Usage: node test-check-junk.mjs <mailbox-email>

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const MAILBOX = process.argv[2];

if (!MAILBOX) {
  console.error('Usage: node test-check-junk.mjs <mailbox-email>');
  process.exit(1);
}

async function main() {
  const { rows } = await pool.query(`SELECT tokens_json FROM oauth_tokens WHERE email = $1`, [MAILBOX]);
  if (!rows.length) {
    console.error(`No OAuth token found for ${MAILBOX}`);
    await pool.end();
    process.exit(1);
  }
  const tokens = JSON.parse(rows[0].tokens_json);

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const refreshRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
      scope: 'https://graph.microsoft.com/Mail.Read offline_access',
    }),
  });
  const refreshData = await refreshRes.json();
  if (!refreshRes.ok) {
    console.error(`Token refresh FAILED (${refreshRes.status}):`, JSON.stringify(refreshData, null, 2));
    await pool.end();
    process.exit(1);
  }
  const accessToken = refreshData.access_token;
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  for (const folder of ['inbox', 'junkemail']) {
    console.log(`\n--- ${folder} (most recent 10) ---`);
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=10&$orderby=receivedDateTime desc&$select=subject,from,receivedDateTime`,
      { headers: authHeader }
    );
    if (!res.ok) {
      console.error(`FAILED (${res.status}):`, await res.text());
      continue;
    }
    const data = await res.json();
    if (!data.value?.length) { console.log('(empty)'); continue; }
    for (const msg of data.value) {
      console.log(`  [${msg.receivedDateTime}] ${msg.subject}  <${msg.from?.emailAddress?.address}>`);
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error('Unexpected error:', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
