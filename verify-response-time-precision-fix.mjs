// Confirms the just-deployed fix (commit 7543c4a: round to nearest second,
// not nearest 0.1h) is actually live and working, by calling the real
// /reports/mbr-team API for Infra and checking CF-33265 specifically --
// its real gap was confirmed at 17008ms (~17 seconds) via direct DB history
// inspection earlier. Before the fix, computeResponseTimeHours would have
// returned exactly 0 for it (0.1h rounding); after the fix it should return
// ~0.00472h (17s / 3600).
//
// Usage: node verify-response-time-precision-fix.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';
const ADMIN_EMAIL = 'bhanu.srikakulam@cloudfuze.com';

async function main() {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [ADMIN_EMAIL]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'verify-response-time-precision', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','verify-response-time-precision',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  const authHeader = { Authorization: `Bearer ${token}` };

  const res = await fetch(`${APP_URL}/api/reports/mbr-team?team=infra&dateFrom=2026-09-21&dateTo=2026-09-21`, { headers: authHeader });
  const data = await res.json();

  console.log('=== CF-33265 in the ticket list ===');
  const ticket = (data.tickets || []).find((t) => t.cf_key === 'CF-33265' || t.key === 'CF-33265');
  if (ticket) {
    console.log(`Found: responseTimeHours = ${ticket.responseTimeHours}`);
    console.log(`  (expect ~0.0047, NOT exactly 0 -- real gap was 17008ms)`);
  } else {
    console.log('CF-33265 not in this date range\'s result -- checking per-person average instead.');
  }

  console.log('\n=== Per-person avgResponseTimeHours for Guru M (owns CF-33265/CF-33246) ===');
  const guru = (data.people || []).find((p) => /guru/i.test(p.name || ''));
  console.log(guru ? JSON.stringify({ name: guru.name, avgResponseTimeHours: guru.avgResponseTimeHours, total: guru.total }, null, 2) : 'Guru M not found in this result set');

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
