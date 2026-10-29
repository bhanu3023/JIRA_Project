// Read-only: hit the REAL /api/issues/:key endpoint (same code path the
// ticket detail page's SLA panel uses) for CF-33699 and CF-33837, and dump
// the exact `sla` array it returns -- zero risk of manually re-deriving
// computeSLAInstancesPure's logic wrong, since this calls the real function.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'sla-api-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','sla-api-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  for (const key of ['CF-33699', 'CF-33837']) {
    const res = await fetch(`${APP_URL}/api/issues/${key}`, { headers: authHeader, signal: AbortSignal.timeout(30000) });
    const data = await res.json();
    console.log(`\n=== ${key} (status ${res.status}) ===`);
    console.log('sla array:', JSON.stringify(data.sla, null, 2));
  }

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
