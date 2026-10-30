// Read-only: hit the REAL /api/issues endpoint (same code Filters uses),
// scoped to Queue: Dev, searching for CF-33117 specifically, to see its
// live sla_breached / sla_breached_by fields after the fix deploy.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'cf33117-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','cf33117-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  for (const dept of ['Dev', 'QA']) {
    const url = `${APP_URL}/api/issues?spaceKey=TESTIN&dept=${dept}&queueMembersOnly=true&q=CF-33117&page=1&limit=10`;
    const res = await fetch(url, { headers: authHeader, signal: AbortSignal.timeout(30000) });
    const data = await res.json();
    const issue = (data.issues || []).find((i) => (i.cfKey || i.key) === 'CF-33117');
    console.log(`\n=== Queue: ${dept} ===`);
    if (!issue) { console.log('CF-33117 not found under this queue.'); continue; }
    console.log('sla_breached:', issue.sla_breached);
    console.log('sla_breached_by:', issue.sla_breached_by);
    console.log('sla_breached_dept:', issue.sla_breached_dept);
    console.log('overdue:', issue.overdue);
  }

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
