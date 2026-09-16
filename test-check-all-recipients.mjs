// Checks whether a specific notification subject actually reached MULTIPLE
// recipients' real mailboxes (Inbox + Junk) in one pass, instead of one
// command per person. Only checks mailboxes that already have a working
// OAuth connection in this system (query oauth_tokens to find more).
//
// Usage: node test-check-all-recipients.mjs "<subject substring>" <email1> <email2> ...

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SUBJECT_SUBSTR = process.argv[2];
const RECIPIENTS = process.argv.slice(3);

if (!SUBJECT_SUBSTR || !RECIPIENTS.length) {
  console.error('Usage: node test-check-all-recipients.mjs "<subject substring>" <email1> <email2> ...');
  process.exit(1);
}

async function getAccessToken(email) {
  const { rows } = await pool.query(`SELECT tokens_json FROM oauth_tokens WHERE email = $1`, [email]);
  if (!rows.length) return null;
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
  if (!refreshRes.ok) return null;
  return (await refreshRes.json()).access_token;
}

async function checkFolder(accessToken, folder, subjectSubstr) {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=25&$orderby=receivedDateTime desc&$select=subject,receivedDateTime`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return (data.value || []).find((m) => (m.subject || '').includes(subjectSubstr)) || null;
}

async function main() {
  console.log(`Checking ${RECIPIENTS.length} mailbox(es) for a subject containing "${SUBJECT_SUBSTR}"...\n`);
  for (const email of RECIPIENTS) {
    const accessToken = await getAccessToken(email);
    if (!accessToken) {
      console.log(`${email}: NO OAUTH CONNECTION -- can't check this mailbox directly.`);
      continue;
    }
    const inInbox = await checkFolder(accessToken, 'inbox', SUBJECT_SUBSTR);
    const inJunk = await checkFolder(accessToken, 'junkemail', SUBJECT_SUBSTR);
    if (inInbox) {
      console.log(`${email}: FOUND in Inbox at ${inInbox.receivedDateTime}`);
    } else if (inJunk) {
      console.log(`${email}: FOUND in Junk at ${inJunk.receivedDateTime}`);
    } else {
      console.log(`${email}: NOT FOUND in Inbox or Junk (checked most recent 25 in each).`);
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error('Unexpected error:', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
