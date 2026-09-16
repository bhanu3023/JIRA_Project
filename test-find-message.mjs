// Searches EVERY mail folder of a recipient's own mailbox for a message
// matching a subject substring, using that account's own already-connected
// OAuth token. Used to check whether a "sent but never seen" message landed
// somewhere unexpected (Clutter, a rule-created folder, etc.) rather than
// genuinely vanishing -- without needing a NEW OAuth consent, since this
// account is already connected.
//
// Usage: node test-find-message.mjs <mailbox-email> <subject-substring>

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const MAILBOX = process.argv[2];
const SUBJECT_SUBSTR = process.argv[3];

if (!MAILBOX || !SUBJECT_SUBSTR) {
  console.error('Usage: node test-find-message.mjs <mailbox-email> <subject-substring>');
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

  // $search covers every folder in one call (unlike listing each folder
  // individually), including ones a $filter-based per-folder walk would
  // miss without knowing its name up front.
  console.log(`Searching all of ${MAILBOX}'s mail for subject containing "${SUBJECT_SUBSTR}"...`);
  const searchRes = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?$search="subject:${SUBJECT_SUBSTR}"&$select=subject,receivedDateTime,parentFolderId,from`,
    { headers: { ...authHeader, ConsistencyLevel: 'eventual' } }
  );
  if (!searchRes.ok) {
    console.error(`SEARCH FAILED (${searchRes.status}):`, await searchRes.text());
    await pool.end();
    return;
  }
  const searchData = await searchRes.json();
  if (!searchData.value?.length) {
    console.log(`NOT FOUND anywhere in ${MAILBOX}'s mailbox (searched all folders).`);
    console.log(`=> The message genuinely never arrived here at all -- points to a mail-flow rule, quarantine, or block happening before it ever reached this mailbox.`);
    await pool.end();
    return;
  }
  for (const msg of searchData.value) {
    // Resolve the folder id to a human name.
    let folderName = msg.parentFolderId;
    try {
      const folderRes = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${msg.parentFolderId}`, { headers: authHeader });
      if (folderRes.ok) folderName = (await folderRes.json()).displayName;
    } catch {}
    console.log(`FOUND: "${msg.subject}" from ${msg.from?.emailAddress?.address} in folder "${folderName}" at ${msg.receivedDateTime}`);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error('Unexpected error:', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
