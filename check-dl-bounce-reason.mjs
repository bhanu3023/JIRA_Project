// The app IS successfully sending the queue-DL notifications via Graph, but
// they immediately bounce back as "Undeliverable" from Microsoft Exchange.
// The bounce SUBJECT alone doesn't say why (bad address? not mail-enabled?
// something else?) -- fetching the actual NDR message body via Graph API
// (using the same OAuth-connected mailbox the app already sends from) to
// get the real diagnostic code before telling the user this needs their
// M365 admin. Read-only -- only reads mail, sends/changes nothing.
//
// Usage: node check-dl-bounce-reason.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log('DEFAULT_NOTIFICATION_SENDER =', process.env.DEFAULT_NOTIFICATION_SENDER || '(not set)');

  const { rows } = await pool.query(`SELECT email, tokens_json FROM oauth_tokens ORDER BY email`);
  console.log(`\n${rows.length} OAuth-connected mailbox(es):`);
  for (const r of rows) console.log(`  ${r.email}`);

  // Try the default sender first (that's who these DL emails actually went
  // out FROM, so bounces come back TO it), falling back to trying each
  // connected mailbox until one has a matching NDR.
  const candidates = [process.env.DEFAULT_NOTIFICATION_SENDER, ...rows.map(r => r.email)].filter(Boolean);

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) { console.log('\nNo MICROSOFT_CLIENT_ID/SECRET in env -- cannot refresh tokens.'); await pool.end(); return; }

  for (const email of candidates) {
    const tokRow = rows.find(r => r.email.toLowerCase() === String(email).toLowerCase());
    if (!tokRow) continue;
    let tokens;
    try { tokens = JSON.parse(tokRow.tokens_json); } catch { continue; }

    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokens.refreshToken,
        scope: 'https://graph.microsoft.com/Mail.Read offline_access email openid profile',
      }),
    });
    if (!tokenRes.ok) {
      console.log(`\n[${email}] Token refresh failed: ${tokenRes.status} ${await tokenRes.text().catch(()=> '')}`);
      continue;
    }
    const { access_token } = await tokenRes.json();
    console.log(`\n[${email}] Got Graph token, searching for a bounce message...`);

    const searchRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages?$search="Undeliverable cfmigrationsupport"&$top=3&$select=id,subject,receivedDateTime,from`,
      { headers: { Authorization: `Bearer ${access_token}`, ConsistencyLevel: 'eventual' } }
    );
    if (!searchRes.ok) {
      console.log(`  Search failed: ${searchRes.status} ${await searchRes.text().catch(()=>'')}`);
      continue;
    }
    const searchData = await searchRes.json();
    const msgs = searchData.value || [];
    console.log(`  Found ${msgs.length} matching message(s)`);
    if (!msgs.length) continue;

    for (const m of msgs) {
      const bodyRes = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${m.id}?$select=subject,body`,
        { headers: { Authorization: `Bearer ${access_token}` } }
      );
      if (!bodyRes.ok) continue;
      const full = await bodyRes.json();
      const text = String(full.body?.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log(`\n  --- ${full.subject} ---`);
      console.log(`  ${text.slice(0, 1500)}`);
    }
    // Found a working mailbox with results -- no need to try the rest.
    await pool.end();
    return;
  }

  console.log('\nNo NDR found in any connected mailbox.');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
