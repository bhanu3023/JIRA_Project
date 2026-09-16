// Directly tests whether no-reply@cloudfuze.info can actually send mail via
// Microsoft Graph right now -- bypasses the app's UI entirely so there's no
// ambiguity about whether a real action was performed in the browser.
//
// Usage: node test-send-graph.mjs <recipient-email>

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SENDER = 'no-reply@cloudfuze.info';
const TO = process.argv[2];

if (!TO) {
  console.error('Usage: node test-send-graph.mjs <recipient-email>');
  process.exit(1);
}

async function main() {
  const { rows } = await pool.query(`SELECT tokens_json FROM oauth_tokens WHERE email = $1`, [SENDER]);
  if (!rows.length) {
    console.error(`No OAuth token found for ${SENDER}`);
    await pool.end();
    process.exit(1);
  }
  let tokens = JSON.parse(rows[0].tokens_json);
  console.log(`Found stored token for ${SENDER}. Has refreshToken: ${!!tokens.refreshToken}`);

  // Always refresh -- simplest way to prove the connection is genuinely alive
  // right now, not just that a token was once issued.
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  console.log(`Refreshing token for ${SENDER}...`);
  const refreshRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
      scope: 'https://graph.microsoft.com/Mail.Send offline_access',
    }),
  });
  const refreshData = await refreshRes.json();
  if (!refreshRes.ok) {
    console.error(`Token refresh FAILED (${refreshRes.status}):`, JSON.stringify(refreshData, null, 2));
    await pool.end();
    process.exit(1);
  }
  console.log('Token refresh succeeded.');
  const accessToken = refreshData.access_token;

  console.log(`Sending test email to ${TO} via Graph as ${SENDER}...`);
  const sendRes = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject: 'Neutara Ticketing — notification test',
        body: { contentType: 'Text', content: `This is a direct test of the ${SENDER} Graph connection, sent at ${new Date().toISOString()}.` },
        toRecipients: [{ emailAddress: { address: TO } }],
      },
      saveToSentItems: 'false',
    }),
  });

  if (sendRes.status === 202) {
    console.log(`SUCCESS -- Graph accepted the send (202). Check ${TO}'s inbox.`);
  } else {
    const errBody = await sendRes.text();
    console.error(`SEND FAILED (${sendRes.status}):`, errBody);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error('Unexpected error:', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
