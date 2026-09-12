// One-off test: can this account get a Graph token WITHOUT an interactive
// browser sign-in, via the OAuth2 "Resource Owner Password Credentials"
// (ROPC) grant (grant_type=password)? This only works if the tenant allows
// legacy/non-interactive auth for this flow specifically -- the same
// Conditional Access policy that blocks SMTP AUTH tenant-wide (confirmed
// via test-smtp.mjs: "SmtpClientAuthentication is disabled for the Tenant")
// very likely blocks this too, since Microsoft classifies ROPC as legacy
// auth as well. This script exists purely to get a definitive yes/no
// without needing anyone to click through a browser OAuth consent screen.
//
// Usage (run inside the app container -- reuses its own
// MICROSOFT_CLIENT_ID/MICROSOFT_CLIENT_SECRET):
//   TEST_MS_USER='No-reply@cloudfuze.info' TEST_MS_PASS='...' node test-ropc.mjs

const clientId     = process.env.MICROSOFT_CLIENT_ID;
const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
const user          = process.env.TEST_MS_USER;
const pass          = process.env.TEST_MS_PASS;

if (!clientId || !clientSecret) {
  console.error('MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET not set in this process.');
  process.exit(1);
}
if (!user || !pass) {
  console.error('Set TEST_MS_USER and TEST_MS_PASS env vars.');
  process.exit(1);
}

console.log(`Testing ROPC (non-interactive) token request as: ${user}`);

const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type:    'password',
    client_id:     clientId,
    client_secret: clientSecret,
    username:      user,
    password:      pass,
    scope:         'https://graph.microsoft.com/Mail.Send offline_access',
  }),
});

const data = await res.json().catch(() => ({}));
if (res.ok && data.access_token) {
  console.log('ROPC SUCCEEDED -- got a Graph access token non-interactively.');
  console.log('refresh_token present:', !!data.refresh_token);
} else {
  console.error(`ROPC FAILED (${res.status}):`, JSON.stringify(data, null, 2));
}
