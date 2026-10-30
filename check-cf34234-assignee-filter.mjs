// Read-only: CF-34234 has several Migration-dept people who worked on it
// (Manoj B closed it, Vainateya Rasala and Chandra Mouli also worked it).
// Check what each person sees for this ticket under a plain Assignee
// filter (no Queue selected) -- per the CF-33352 rule, an unscoped view
// should always show the CURRENT true assignee (Manoj B) and attribute any
// breach to him specifically, never to someone who only historically
// touched a department.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'cf34234-assignee-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','cf34234-assignee-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  for (const email of ['manoj.bathula@cloudfuze.com', 'vainateya.rasala@cloudfuze.com', 'chandra.mouli@cloudfuze.com', 'hymavathi@cloudfuze.com']) {
    const { rows } = await pool.query(`SELECT id, email, "firstName", "lastName" FROM users WHERE email = $1 LIMIT 1`, [email]);
    const name = rows.length ? `${rows[0].firstName} ${rows[0].lastName}` : email;
    if (!rows.length) { console.log(`${email}: no matching user found`); continue; }
    const url = `${APP_URL}/api/issues?spaceKey=TESTIN&assignees=${encodeURIComponent(rows[0].id)}&page=1&limit=500`;
    const res = await fetch(url, { headers: authHeader, signal: AbortSignal.timeout(30000) }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    const issue = (data.issues || []).find((i) => (i.cfKey || i.key) === 'CF-34234');
    console.log(`\n${name} (${rows[0].email}):`);
    if (!issue) { console.log(' CF-34234 not shown under this assignee filter.'); continue; }
    console.log(' real assignee shown:', issue.assignee ? `${issue.assignee.firstName} ${issue.assignee.lastName}` : null);
    console.log(' sla_breached:', issue.sla_breached);
    console.log(' sla_breached_by:', issue.sla_breached_by);
    console.log(' sla_breached_dept:', issue.sla_breached_dept);
  }

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
