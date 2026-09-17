// Checks, across a whole list of recently-notified tickets (not just one),
// whether each one's email landed in Inbox, Junk, or neither -- gives a
// precise "X of Y" scope instead of anecdotal single-ticket checks.
//
// Usage: node check-scope-of-junk-placement.mjs <mailbox-email> <CF-KEY> [<CF-KEY> ...]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const MAILBOX = process.argv[2];
const KEYS = process.argv.slice(3);

if (!MAILBOX || !KEYS.length) {
  console.error('Usage: node check-scope-of-junk-placement.mjs <mailbox-email> <CF-KEY> [<CF-KEY> ...]');
  process.exit(1);
}

async function main() {
  const { rows } = await pool.query(`SELECT tokens_json FROM oauth_tokens WHERE email = $1`, [MAILBOX]);
  if (!rows.length) { console.error(`No OAuth token for ${MAILBOX}`); await pool.end(); process.exit(1); }
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

  async function search(folder) {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=50&$orderby=receivedDateTime desc&$select=subject,receivedDateTime`,
      { headers: authHeader }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.value || [];
  }

  const inbox = await search('inbox');
  const junk = await search('junkemail');

  let inInbox = 0, inJunk = 0, nowhere = 0;
  console.log(`Checking ${KEYS.length} ticket(s) against ${MAILBOX}'s most recent 50 Inbox + 50 Junk messages:\n`);
  for (const key of KEYS) {
    const foundInbox = inbox.find(m => (m.subject || '').includes(`[${key}]`));
    const foundJunk = junk.find(m => (m.subject || '').includes(`[${key}]`));
    if (foundInbox) { inInbox++; console.log(`  ${key}: INBOX  (${foundInbox.subject})`); }
    else if (foundJunk) { inJunk++; console.log(`  ${key}: JUNK   (${foundJunk.subject})`); }
    else { nowhere++; console.log(`  ${key}: NOT FOUND in either (may not have been sent to this mailbox, or outside the 50 most recent)`); }
  }

  console.log(`\nSummary: ${inInbox} in Inbox, ${inJunk} in Junk, ${nowhere} not found -- out of ${KEYS.length} checked.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
