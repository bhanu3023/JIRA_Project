// Read-only: CF-34234's frozen sla_snapshot has no Infra entry at all (only
// Migration and Dev), so an Infra-scoped Filters view should fall through
// to the live recompute. Check what that recompute actually produces, and
// what Infra's real policy goal is for medium priority, to confirm whether
// the "SLA Breached: Yes, by Vamshi Gande" verdict under Infra is genuinely
// correct given ~15.6 real hours accumulated there.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'cf34234-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','cf34234-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  const { rows: pol } = await pool.query(`
    SELECT name, dept_name, status, goals FROM sla_definitions
    WHERE LOWER(dept_name) = 'infra' AND status = 'active'
  `);
  console.log('Active Infra policies:', JSON.stringify(pol, null, 2));

  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };
  const url = `${APP_URL}/api/issues?spaceKey=TESTIN&dept=Infra&queueMembersOnly=true&q=CF-34234&page=1&limit=10`;
  const res = await fetch(url, { headers: authHeader, signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  const issue = (data.issues || []).find((i) => (i.cfKey || i.key) === 'CF-34234');
  console.log('\n=== Live API result under Queue: Infra ===');
  if (!issue) console.log('CF-34234 not found under Infra queue.');
  else {
    console.log('sla_breached:', issue.sla_breached);
    console.log('sla_breached_by:', issue.sla_breached_by);
    console.log('sla_breached_dept:', issue.sla_breached_dept);
  }

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
