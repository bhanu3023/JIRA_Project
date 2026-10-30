// Read-only: for every ticket the live Filters API currently shows as "SLA
// Breached: Yes" under Dev/QA/Infra/Migration, verify there's an actual
// "SLA breached — <Dept>" entry in that ticket's OWN History log for that
// department. If a ticket shows breached=true with ZERO supporting History
// trail, that's a real red flag worth investigating individually -- a
// computed flag with no real event behind it.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'breach-history-crosscheck', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','breach-history-crosscheck',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  let totalChecked = 0, hasHistory = 0, noHistory = 0;
  const missing = [];
  for (const dept of ['Dev', 'QA', 'Infra', 'Migration']) {
    const url = `${APP_URL}/api/issues?spaceKey=TESTIN&dept=${dept}&queueMembersOnly=true&slaBreached=yes&page=1&limit=500`;
    const res = await fetch(url, { headers: authHeader, signal: AbortSignal.timeout(60000) }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    const issues = data.issues || [];

    for (const issue of issues) {
      totalChecked++;
      const { rows } = await pool.query(`
        SELECT 1 FROM issue_history
        WHERE "issueId" = $1 AND field = 'sla' AND "newValue" ILIKE $2
        LIMIT 1
      `, [issue.id, `SLA breached — ${dept}%`]);
      if (rows.length) hasHistory++;
      else { noHistory++; missing.push({ key: issue.cfKey || issue.key, dept, breachedBy: issue.sla_breached_by }); }
    }
  }

  console.log(`Total currently-breached tickets checked: ${totalChecked}`);
  console.log(`Have a matching "SLA breached" History entry: ${hasHistory}`);
  console.log(`NO matching History entry at all (red flag): ${noHistory}`);
  console.log('\nTickets with no supporting History trail:');
  for (const m of missing.slice(0, 40)) console.log(` - ${m.key} (dept=${m.dept}, sla_breached_by=${m.breachedBy})`);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
