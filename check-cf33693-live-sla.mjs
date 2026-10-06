// Settle definitively whether computeSLAInstancesPure actually returns an
// instance for CF-33693 (Infra, no sla_definitions row exists for Infra)
// by calling the real, live issue-detail endpoint and reading its `sla`
// field directly -- rather than guessing which of several SLA-adjacent
// UI surfaces the user means. Read-only (GET request).
//
// Usage: node check-cf33693-live-sla.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email, role FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'sla-verify-script', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'sla-verify-script', new Date(Date.now() + 3600 * 1000)]
  );

  for (const key of ['CF-33693', 'CF-33775']) {
    const res = await fetch(`http://localhost:${PORT}/api/issues/${key}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    console.log(`\n${key}: current_department=${data.current_department}`);
    console.log('sla field:', JSON.stringify(data.sla, null, 2));
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
