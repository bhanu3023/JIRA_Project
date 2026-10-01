// Sends an EXACT replica of the real buildEmailHtml template (header bar,
// colored event banner, title wrapped in its own link, fields table, CTA
// link) with realistic content -- the earlier 3-variant test used much
// simpler one-off HTML and concluded the styled CTA button alone was the
// trigger, but a real notification just failed to arrive even after that
// fix, so something about the FULL real structure needs testing as a whole,
// not just the CTA element in isolation.
//
// Usage: node test-send-real-template.mjs <recipient-email>

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SENDER = 'no-reply@cloudfuze.info';
const TO = process.argv[2];

if (!TO) {
  console.error('Usage: node test-send-real-template.mjs <recipient-email>');
  process.exit(1);
}

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
      scope: 'https://graph.microsoft.com/Mail.Send offline_access',
    }),
  });
  const accessToken = (await refreshRes.json()).access_token;

  const stamp = Date.now();
  const actionUrl = `https://neutaraticketing.cftools.live/issues/CF-33052`;
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1)">
    <div style="background:#0052CC;padding:16px 24px;display:flex;align-items:center">
      <span style="color:white;font-size:18px;font-weight:bold">No-reply</span>
    </div>
    <div style="background:#0052CC;padding:10px 24px">
      <span style="color:white;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Assigned</span>
    </div>
    <div style="padding:20px 24px 8px">
      <a href="${actionUrl}" style="text-decoration:none">
        <span style="font-size:12px;color:#0052CC;font-weight:600">CF-33052</span>
        <h2 style="margin:4px 0 0;font-size:18px;color:#172B4D;line-height:1.3">Template test ${stamp}</h2>
      </a>
      <p style="margin:4px 0 0;font-size:12px;color:#888">CloudFuze Board</p>
    </div>
    <div style="padding:8px 24px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:6px 12px;color:#666;font-size:13px;width:130px;vertical-align:top;white-space:nowrap">Assignee</td><td style="padding:6px 12px;font-size:13px;color:#333;font-weight:400">Ravi Srivastava</td></tr>
        <tr><td style="padding:6px 12px;color:#666;font-size:13px;width:130px;vertical-align:top;white-space:nowrap">Status</td><td style="padding:6px 12px;font-size:13px;color:#333;font-weight:400">Open</td></tr>
      </table>
    </div>
    <div style="padding:16px 24px 24px">
      <a href="${actionUrl}" style="color:#0052CC;font-size:14px;font-weight:600;text-decoration:underline">
        View Issue &rarr;
      </a>
    </div>
    <div style="padding:12px 24px;background:#f4f5f7;border-top:1px solid #e8e8e8">
      <p style="margin:0;font-size:11px;color:#888">
        You received this because you are the assignee or reporter of this issue.<br/>
        https://neutaraticketing.cftools.live
      </p>
    </div>
  </div>
</body>
</html>`;

  const subject = `[CF-33052] Template replica test ${stamp}`;
  const sendRes = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: TO } }] },
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
