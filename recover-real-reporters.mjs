// For the 2 tickets confirmed to have an emailthreadid on file
// (CF-30814, CF-30805) and genuinely no reporter recorded anywhere,
// looks up the original email by its Internet Message-ID across every
// connected OAuth mailbox, and uses the REAL sender as the reporter --
// either linking to a real `users` row if the sender's email matches
// one, or storing their real name/email in jira_reporter_name if not
// (e.g. an external customer with no account in this system). Never
// fabricates a name -- if the message can't be found in any connected
// mailbox, the ticket is left untouched and reported as unrecoverable.
// Dry-run by default; pass --apply to write.
//
// Usage: node recover-real-reporters.mjs [--apply]
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const clientId = process.env.MICROSOFT_CLIENT_ID;
const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

function rid() { return 'hist_' + Math.random().toString(36).slice(2, 12); }

async function getAccessToken(email) {
  const { rows } = await pool.query(`SELECT tokens_json FROM oauth_tokens WHERE email = $1`, [email]);
  if (!rows.length) return null;
  const tokens = JSON.parse(rows[0].tokens_json);
  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
      scope: 'https://graph.microsoft.com/Mail.Read offline_access email openid profile',
    }),
  });
  const data = await res.json();
  return data.access_token || null;
}

async function findMessageAcrossMailboxes(internetMessageId) {
  const { rows: mailboxes } = await pool.query(`SELECT email FROM oauth_tokens`);
  for (const { email } of mailboxes) {
    const token = await getAccessToken(email);
    if (!token) continue;
    const filterVal = internetMessageId.replace(/'/g, "''");
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages?$filter=internetMessageId eq '${encodeURIComponent(filterVal)}'&$select=subject,from,sender,receivedDateTime`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) continue;
    const data = await res.json().catch(() => null);
    const msg = (data?.value || [])[0];
    if (msg) return { mailbox: email, msg };
  }
  return null;
}

async function main() {
  const { rows: tickets } = await pool.query(`
    SELECT id, COALESCE(cf_key, key) AS key, emailthreadid
    FROM issues
    WHERE "reporterId" IS NULL AND (jira_reporter_name IS NULL OR jira_reporter_name = '')
      AND emailthreadid IS NOT NULL AND emailthreadid != ''
  `);
  console.log(`Found ${tickets.length} candidate tickets:`, tickets.map(t => t.key).join(', '));

  for (const t of tickets) {
    console.log(`\n--- ${t.key} ---`);
    const found = await findMessageAcrossMailboxes(t.emailthreadid);
    if (!found) {
      console.log(`  Not found in any connected mailbox -- leaving untouched (unrecoverable).`);
      continue;
    }
    const sender = found.msg.from?.emailAddress || found.msg.sender?.emailAddress;
    if (!sender?.address) {
      console.log(`  Message found but has no sender address -- leaving untouched.`);
      continue;
    }
    console.log(`  Found via mailbox ${found.mailbox}: sender = ${sender.name} <${sender.address}>`);

    const { rows: matchedUsers } = await pool.query(
      `SELECT id, "firstName", "lastName" FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [sender.address]
    );
    const matchedUser = matchedUsers[0];

    if (!APPLY) { console.log('  (dry run -- would apply above)'); continue; }

    if (matchedUser) {
      await pool.query(`UPDATE issues SET "reporterId" = $1, "updatedAt" = NOW() WHERE id = $2`, [matchedUser.id, t.id]);
      console.log(`  Linked to real user: ${matchedUser.firstName} ${matchedUser.lastName}`);
    } else {
      const displayName = sender.name ? `${sender.name} <${sender.address}>` : sender.address;
      await pool.query(`UPDATE issues SET jira_reporter_name = $1, "updatedAt" = NOW() WHERE id = $2`, [displayName, t.id]);
      console.log(`  No matching user account -- stored raw sender identity: ${displayName}`);
    }
    await pool.query(
      `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt")
       VALUES ($1, $2, 'reporter', 'None', $3, $4, $5, NOW())`,
      [rid(), t.id, matchedUser ? `${matchedUser.firstName} ${matchedUser.lastName}` : sender.address, 'System (recovered from source email)', 'system@neutara']
    );
  }

  if (!APPLY) console.log('\nDry run only -- re-run with --apply to write.');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
