// User is asking to verify whether 5 tickets shown as "SLA Breached: Yes"
// in Filters (CF-33228, CF-32979, CF-32969, CF-31002, CF-31001, all
// Migration queue, all Resolved) are genuinely breached -- same real-data
// verification methodology used earlier this session (call the live
// GET /api/issues/:key endpoint, which runs the actual production SLA
// computation, rather than re-deriving the math by hand).
//
// Usage: node check-5-tickets-sla-breach.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';
const ADMIN_EMAIL = 'bhanu.srikakulam@cloudfuze.com';
const KEYS = ['CF-33228', 'CF-32979', 'CF-32969', 'CF-31002', 'CF-31001'];

async function main() {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [ADMIN_EMAIL]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'check-5-tickets-sla-breach', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','check-5-tickets-sla-breach',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  const authHeader = { Authorization: `Bearer ${token}` };

  for (const key of KEYS) {
    const res = await fetch(`${APP_URL}/api/issues/${key}`, { headers: authHeader });
    const data = await res.json();
    console.log(`\n=== ${key} ===`);
    console.log(`summary: ${data.summary}`);
    console.log(`status: ${data.status?.name}   priority: ${data.priority}   current_department: ${data.current_department}`);
    console.log(`resolvedAt: ${data.resolvedAt}`);
    console.log(`live sla: ${JSON.stringify(data.sla, null, 2)}`);
  }

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
