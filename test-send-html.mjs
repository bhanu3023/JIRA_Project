// Sends an HTML email with a clickable link, matching the real app's
// notification format (buildEmailHtml), unlike the earlier plain-text test
// script. If this one never lands anywhere (not even Junk) while the plain
// text one landed in Junk, that's strong evidence Microsoft Defender is
// quarantining the HTML+link version outright for this brand-new sender.
//
// Usage: node test-send-html.mjs <recipient-email>

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SENDER = 'no-reply@cloudfuze.info';
const TO = process.argv[2];

if (!TO) {
  console.error('Usage: node test-send-html.mjs <recipient-email>');
  process.exit(1);
}

async function main() {
  const { rows } = await pool.query(`SELECT tokens_json FROM oauth_tokens WHERE email = $1`, [SENDER]);
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
      scope: 'https://graph.microsoft.com/Mail.Send offline_access',
    }),
  });
  const refreshData = await refreshRes.json();
  const accessToken = refreshData.access_token;

  const subject = `Neutara Ticketing — HTML link test ${Date.now()}`;
  const html = `
    <div style="font-family:sans-serif;max-width:500px">
      <h2 style="color:#0052CC">Status Changed</h2>
      <p>This is a test matching the real notification template's shape.</p>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:4px;color:#666">Status</td><td style="padding:4px">Open &rarr; In Progress</td></tr>
      </table>
      <p><a href="https://neutaraticketing.cftools.live/issues/CF-33015" style="background:#0052CC;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none">View Ticket</a></p>
    </div>`;

  const sendRes = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: TO } }],
      },
      saveToSentItems: true,
    }),
  });
  console.log(`Send status: ${sendRes.status}`);
  if (sendRes.status !== 202) console.error(await sendRes.text());
  else console.log(`Subject to look for: "${subject}"`);
  await pool.end();
}

main().catch(async (e) => {
  console.error('Unexpected error:', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
