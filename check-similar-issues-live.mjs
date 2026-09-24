// User typed "User limit exceeded | NatGeo | Dropbox - Shared drive" as a
// new ticket's summary, with CF-33377 (a real, similar-looking existing
// ticket) visible right behind the modal -- but no reference ticket showed
// up at all, not even a loading state, suggesting the feature (commit
// 4268c23) might not be deployed yet rather than a matching bug. Calls the
// real live GET /issues/similar endpoint directly with the exact same
// input to check both possibilities: does the endpoint exist and work at
// all, and if so, does it actually find CF-33377.
//
// Usage: node check-similar-issues-live.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';
const ADMIN_EMAIL = 'bhanu.srikakulam@cloudfuze.com';

async function main() {
  const { rows: cf33377 } = await pool.query(`SELECT summary, "spaceId" FROM issues WHERE cf_key = 'CF-33377' OR key = 'CF-33377'`);
  console.log('=== CF-33377 real summary (for reference) ===');
  console.log(cf33377[0]?.summary || 'NOT FOUND');

  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [ADMIN_EMAIL]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'check-similar-issues-live', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','check-similar-issues-live',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  const authHeader = { Authorization: `Bearer ${token}` };

  const summary = 'User limit exceeded | NatGeo | Dropbox - Shared drive';
  const params = new URLSearchParams({ spaceKey: 'TESTIN', summary });
  const res = await fetch(`${APP_URL}/api/issues/similar?${params.toString()}`, { headers: authHeader });
  console.log(`\n=== GET /api/issues/similar?spaceKey=TESTIN&summary=${summary} ===`);
  console.log(`HTTP status: ${res.status}`);
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
