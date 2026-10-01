// Confirms the CF-29758/CF-29399 fixes actually show up in the real live
// Filters page, not just the database -- calls the real /api/issues
// endpoint (Queue:Dev, Assignee:Jaswanth, Worked date range covering both
// tickets' real work dates) and checks both keys are present in the
// returned list.
//
// Usage: node check-jaswanth-filters-live.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';
const EMAIL = 'jaswanth.adari@cloudfuze.com';
const EXPECT_KEYS = ['CF-29758', 'CF-29399'];

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'jaswanth-filters-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','jaswanth-filters-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return token;
}

async function main() {
  const token = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const params = new URLSearchParams({
    spaceKey: 'TESTIN', dept: 'Dev', queueMembersOnly: 'true', assignees: EMAIL,
    workedRange: 'between:2026-08-01:2026-08-31',
    page: '1', limit: '500',
  });
  const res = await fetch(`${APP_URL}/api/issues?${params}`, { headers: authHeader });
  const data = await res.json().catch(() => ({}));
  const issues = data.issues || data.data || [];
  const shownKeys = new Set(issues.map((i) => i.cfKey || i.cf_key || i.key));

  console.log(`Filters (Queue:Dev, Assignee:${EMAIL}, Worked Aug 2026): total=${data.total}, returned=${issues.length}\n`);
  for (const key of EXPECT_KEYS) {
    console.log(`${key}: ${shownKeys.has(key) ? 'PRESENT in Filters — fix confirmed live' : 'STILL MISSING from Filters'}`);
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
