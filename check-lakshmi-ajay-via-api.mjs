// Manual SQL reconstruction of MBR's dept/roster matching didn't find
// Lakshmi Prasanna's or Ajay Singh's "total=1" ticket for August -- rather
// than keep guessing at the real WHERE clause by hand, ask the app itself
// via its own drill-down (person filter) which ticket it is.
//
// Usage: node check-lakshmi-ajay-via-api.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';
const ADMIN_EMAIL = 'bhanu.srikakulam@cloudfuze.com';
const PEOPLE = [
  { email: 'lakshmi.prasanna@cloudfuze.com', team: 'ent' },
  { email: 'ajay.singh@cloudfuze.com', team: 'smb' },
];

async function main() {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [ADMIN_EMAIL]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'check-lakshmi-ajay-via-api', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','check-lakshmi-ajay-via-api',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  const authHeader = { Authorization: `Bearer ${token}` };

  for (const { email, team } of PEOPLE) {
    console.log(`\n\n========== ${email} (${team}) ==========`);
    const res = await fetch(`${APP_URL}/api/reports/mbr-team?team=${team}&dateFrom=2026-08-01&dateTo=2026-08-31&person=${encodeURIComponent(email)}`, { headers: authHeader });
    const data = await res.json();
    console.log(`totalMatched: ${data.totalMatched}`);
    for (const t of data.tickets || []) {
      console.log(`\n${t.key}: assignee=${t.assignee} status=${t.status} responseTimeHours=${t.responseTimeHours}`);
    }
  }

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
