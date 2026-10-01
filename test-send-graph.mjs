// Directly tests whether no-reply@cloudfuze.info can actually send mail via
// Microsoft Graph right now, AND whether it has a real, licensed Exchange
// mailbox behind it at all -- a 202 from /sendMail only means Graph accepted
// the API call structurally, not that a real mailbox actually processed it.
// Bypasses the app's UI entirely so there's no ambiguity about whether a
// real action was performed in the browser, and doesn't require signing
// into the sender mailbox directly (queries it via the same Graph token
// this app already holds).
//
// Usage: node test-send-graph.mjs <recipient-email> [sender-email]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const TO = process.argv[2];
const SENDER = process.argv[3] || 'no-reply@cloudfuze.info';

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
      scope: 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read offline_access',
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
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  // Step 1: does this account have a real, licensed Exchange mailbox at all?
  // A 404 MailboxNotEnabledForRESTAPI here means Graph could issue a token
  // for this identity, but there's no actual mailbox behind it to send from
  // -- the most likely explanation for "202 accepted, nothing ever arrives."
  console.log(`\nChecking whether ${SENDER} has a real Exchange mailbox...`);
  const mbRes = await fetch('https://graph.microsoft.com/v1.0/me/mailFolders/inbox', { headers: authHeader });
  if (mbRes.ok) {
    const mbData = await mbRes.json();
    console.log(`Mailbox exists. Inbox has ${mbData.totalItemCount} total items, ${mbData.unreadItemCount} unread.`);
  } else {
    const mbErr = await mbRes.text();
    console.error(`MAILBOX CHECK FAILED (${mbRes.status}):`, mbErr);
  }

  // Step 2: send a real test email, explicitly SAVING to Sent Items this
  // time (a prior version of this script wrongly set saveToSentItems:
  // false, which would have hidden the very evidence step 3 checks for).
  console.log(`\nSending test email to ${TO} via Graph as ${SENDER}...`);
  const subject = `Neutara Ticketing — notification test ${Date.now()}`;
  const sendRes = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'Text', content: `This is a direct test of the ${SENDER} Graph connection, sent at ${new Date().toISOString()}.` },
        toRecipients: [{ emailAddress: { address: TO } }],
      },
      saveToSentItems: true,
    }),
  });
  if (sendRes.status === 202) {
    console.log(`Graph accepted the send (202).`);
  } else {
    const errBody = await sendRes.text();
    console.error(`SEND FAILED (${sendRes.status}):`, errBody);
    await pool.end();
    return;
  }

  // Step 3: wait a moment, then check whether it actually landed in this
  // mailbox's OWN Sent Items. If it's not there despite the 202, the send
  // never really happened at the mailbox level (no real mailbox / Graph
  // just acknowledging an API call it can't actually fulfill). If it IS
  // there, the message genuinely left this account and the problem is
  // downstream (a transport rule, or the recipient's own filtering).
  console.log(`\nWaiting 5s, then checking ${SENDER}'s own Sent Items for this message...`);
  await new Promise((r) => setTimeout(r, 5000));
  const sentRes = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$filter=subject eq '${subject}'&$select=subject,sentDateTime,toRecipients`,
    { headers: authHeader }
  );
  if (sentRes.ok) {
    const sentData = await sentRes.json();
    if (sentData.value?.length) {
      console.log(`FOUND in Sent Items:`, JSON.stringify(sentData.value[0], null, 2));
      console.log(`\n=> The message genuinely left this mailbox. If it never reached ${TO}, the problem is downstream (a mail-flow/transport rule, or the recipient's own filtering) -- not this app or this OAuth connection.`);
    } else {
      console.log(`NOT FOUND in Sent Items.`);
      console.log(`\n=> Graph accepted the API call (202) but the message never actually landed in this mailbox's own Sent Items -- strong signal this account has no real, licensed Exchange mailbox behind it (or one that isn't provisioned for actual mail flow yet).`);
    }
  } else {
    const sentErr = await sentRes.text();
    console.error(`SENT ITEMS CHECK FAILED (${sentRes.status}):`, sentErr);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error('Unexpected error:', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
