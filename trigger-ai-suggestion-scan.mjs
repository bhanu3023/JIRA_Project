// Manually triggers the AI suggestion scan (normally runs every 30 minutes)
// to test it right away instead of waiting. Prints how many tickets were
// attempted and how many got a drafted suggestion.
//
// Usage: node trigger-ai-suggestion-scan.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const BASE = `http://localhost:${PORT}/api`;

async function main() {
  const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const admin = adminRows[0];
  const payload = { sub: admin.id, ip: '', ua: 'trigger-ai-scan', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'trigger-ai-scan', new Date(Date.now() + 3600 * 1000)]
  );

  console.log('Running AI suggestion scan (may take up to a minute if there are candidates)...\n');
  const res = await fetch(`${BASE}/admin/ai-suggestion-scan`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
