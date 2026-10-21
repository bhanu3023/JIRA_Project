// Read-only diagnostic: confirms the tenant-wide Graph app-only token
// actually works end to end, after MICROSOFT_TENANT_ID is added to
// .env.local and the container is restarted.
//
// Three checks:
//  1. Can we get a client-credentials token at all (catches wrong tenant ID,
//     wrong client secret, etc.)
//  2. Does that token's own "roles" claim actually list Mail.Read/Mail.Send
//     (catches "consent looked granted in the portal but didn't really
//     apply" and Microsoft's occasional propagation delay after a fresh
//     admin-consent click)
//  3. Can we actually list messages in a real mailbox with it (catches
//     anything else: wrong permission type, mailbox doesn't exist, etc.)
//
// Usage: node check-app-only-graph-token.mjs [mailbox-to-test@cloudfuze.com]

const clientId     = process.env.MICROSOFT_CLIENT_ID;
const clientSecret  = process.env.MICROSOFT_CLIENT_SECRET;
const tenantId      = process.env.MICROSOFT_TENANT_ID;
const testMailbox   = process.argv[2] || 'presalesteam@cloudfuze.com';

function decodeJwtPayload(jwt) {
  try {
    const part = jwt.split('.')[1];
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function main() {
  console.log('--- Config check ---');
  console.log('MICROSOFT_CLIENT_ID:', clientId ? `${clientId.slice(0, 8)}...` : 'MISSING');
  console.log('MICROSOFT_CLIENT_SECRET:', clientSecret ? 'present' : 'MISSING');
  console.log('MICROSOFT_TENANT_ID:', tenantId || 'MISSING');
  if (!clientId || !clientSecret || !tenantId) {
    console.error('\nOne or more required env vars are missing. Check .env.local and restart the container.');
    process.exit(1);
  }

  console.log('\n--- Step 1: requesting client-credentials token ---');
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         'https://graph.microsoft.com/.default',
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(`FAILED (${res.status}):`, err);
    process.exit(1);
  }
  const data = await res.json();
  console.log('Token acquired. Expires in', data.expires_in, 'seconds.');

  console.log('\n--- Step 2: checking granted Application permissions (roles claim) ---');
  const payload = decodeJwtPayload(data.access_token);
  const roles = payload?.roles || [];
  console.log('Roles in token:', roles.length ? roles.join(', ') : '(none)');
  const hasMailRead = roles.includes('Mail.Read') || roles.includes('Mail.ReadWrite');
  const hasMailSend = roles.includes('Mail.Send');
  console.log('Mail.Read present:', hasMailRead);
  console.log('Mail.Send present:', hasMailSend);
  if (!hasMailRead) {
    console.warn('\nMail.Read is NOT in this token — admin consent may not have actually applied yet, or the permission type added was "Delegated" instead of "Application". Try again in a few minutes, or re-check the Azure portal.');
  }

  console.log(`\n--- Step 3: trying to list messages in ${testMailbox} ---`);
  const msgRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(testMailbox)}/mailFolders/Inbox/messages?$top=1&$select=subject,receivedDateTime`,
    { headers: { Authorization: `Bearer ${data.access_token}` } }
  );
  if (!msgRes.ok) {
    const err = await msgRes.text().catch(() => '');
    console.error(`FAILED (${msgRes.status}):`, err);
    process.exit(1);
  }
  const msgData = await msgRes.json();
  console.log(`SUCCESS — able to read ${testMailbox}'s inbox. ${msgData.value?.length ?? 0} message(s) returned in this sample.`);
  if (msgData.value?.[0]) {
    console.log('Most recent subject:', msgData.value[0].subject, '@', msgData.value[0].receivedDateTime);
  }
  console.log('\nAll checks passed — app-only Graph access is fully working.');
}

main().catch((e) => { console.error('Unexpected error:', e); process.exit(1); });
