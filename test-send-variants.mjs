// Sends 3 variants back-to-back to isolate exactly what Defender is
// quarantining: (A) HTML, no link at all, (B) HTML with a plain underlined
// text link (no button styling), (C) HTML with the styled button-link,
// matching the real app's exact template. If A or B get through while C
// doesn't, the styled CTA button specifically is the trigger, not HTML/links
// in general -- meaning the real template could be adjusted rather than
// needing an admin fix at all.
//
// Usage: node test-send-variants.mjs <recipient-email>

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SENDER = 'no-reply@cloudfuze.info';
const TO = process.argv[2];

if (!TO) {
  console.error('Usage: node test-send-variants.mjs <recipient-email>');
  process.exit(1);
}

async function getAccessToken() {
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
  return (await refreshRes.json()).access_token;
}

async function send(accessToken, subject, html) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: TO } }] },
      saveToSentItems: true,
    }),
  });
  return res.status;
}

async function main() {
  const accessToken = await getAccessToken();
  const stamp = Date.now();

  const variants = [
    {
      label: 'A: HTML, no link at all',
      subject: `NT variant A ${stamp}`,
      html: `<div style="font-family:sans-serif"><h2>Status Changed</h2><p>Open to In Progress. No link in this one.</p></div>`,
    },
    {
      label: 'B: HTML, plain text link (no button)',
      subject: `NT variant B ${stamp}`,
      html: `<div style="font-family:sans-serif"><h2>Status Changed</h2><p>Open to In Progress. View: https://neutaraticketing.cftools.live/issues/CF-33015</p></div>`,
    },
    {
      label: 'C: HTML, styled CTA button (matches real template)',
      subject: `NT variant C ${stamp}`,
      html: `<div style="font-family:sans-serif"><h2>Status Changed</h2><p>Open to In Progress.</p><p><a href="https://neutaraticketing.cftools.live/issues/CF-33015" style="background:#0052CC;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none">View Ticket</a></p></div>`,
    },
  ];

  for (const v of variants) {
    const status = await send(accessToken, v.subject, v.html);
    console.log(`${v.label} -> HTTP ${status} -- subject: "${v.subject}"`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error('Unexpected error:', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
