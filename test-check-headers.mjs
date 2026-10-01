// Pulls the full internet message headers (Authentication-Results,
// X-Forefront-Antispam-Report, X-Microsoft-Antispam) for the most recent
// Junk-foldered message in a mailbox, so we can see the EXACT reason
// Microsoft's filter scored it as junk (DKIM/SPF/DMARC pass-fail, spam
// confidence level, compauth result) instead of guessing at admin-portal
// settings from outside.
//
// Usage: node test-check-headers.mjs <mailbox-email> [subject-substring]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const MAILBOX = process.argv[2];
const SUBJECT_SUBSTR = process.argv[3] || '';

if (!MAILBOX) {
  console.error('Usage: node test-check-headers.mjs <mailbox-email> [subject-substring]');
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
  const refreshData = await refreshRes.json();
  if (!refreshRes.ok) {
    console.error(`Token refresh FAILED (${refreshRes.status}):`, JSON.stringify(refreshData, null, 2));
    await pool.end();
    process.exit(1);
  }
  const accessToken = refreshData.access_token;
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  const listRes = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages?$top=10&$orderby=receivedDateTime desc&$select=id,subject,receivedDateTime,from`,
    { headers: authHeader }
  );
  const listData = await listRes.json();
  if (!listData.value?.length) {
    console.log('Junk folder is empty.');
    await pool.end();
    return;
  }
  const target = SUBJECT_SUBSTR
    ? listData.value.find(m => (m.subject || '').includes(SUBJECT_SUBSTR))
    : listData.value.find(m => (m.from?.emailAddress?.address || '').toLowerCase().includes('cloudfuze.info'));

  if (!target) {
    console.log('No matching message found in the 10 most recent Junk items:');
    for (const m of listData.value) console.log(`  [${m.receivedDateTime}] ${m.subject} <${m.from?.emailAddress?.address}>`);
    await pool.end();
    return;
  }

  console.log(`Inspecting: [${target.receivedDateTime}] ${target.subject} <${target.from?.emailAddress?.address}>\n`);

  const msgRes = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${target.id}?$select=internetMessageHeaders`,
    { headers: authHeader }
  );
  const msgData = await msgRes.json();
  const headers = msgData.internetMessageHeaders || [];

  const wanted = ['Authentication-Results', 'X-Forefront-Antispam-Report', 'X-Microsoft-Antispam', 'X-MS-Exchange-Organization-SCL', 'X-MS-Exchange-Organization-AuthAs', 'X-MS-Exchange-CrossTenant-AuthSource'];
  for (const w of wanted) {
    const matches = headers.filter(h => h.name.toLowerCase() === w.toLowerCase());
    if (matches.length) {
      for (const m of matches) console.log(`${m.name}: ${m.value}\n`);
    } else {
      console.log(`${w}: (not present)\n`);
    }
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error('Unexpected error:', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
