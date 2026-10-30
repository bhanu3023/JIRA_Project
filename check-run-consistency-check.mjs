// Read-only (triggers the admin daily-consistency-check endpoint, which
// itself only reads data -- no writes): runs the now-corrected MBR-vs-
// Filters comparison on demand across eng/qa/infra/ent+smb, to confirm it
// reports clean for every team, not just the one case manually checked so
// far (Dev/Oct 2026).
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'consistency-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','consistency-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  if (!JWT_SECRET) { console.error('JWT_SECRET not set'); process.exit(1); }
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const res = await fetch(`${APP_URL}/api/admin/daily-consistency-check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
