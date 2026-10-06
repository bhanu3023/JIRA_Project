// Last remaining straggler from the catch-all check. Same targeted
// clear+refresh as CF-30865/CF-33222.
//
// Usage: node refresh-cf29400-sla.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'sla-refresh-last', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'sla-refresh-last', new Date(Date.now() + 3600 * 1000)]
  );

  const key = 'CF-29400';
  const { rows } = await pool.query(`SELECT id FROM issues WHERE cf_key = $1 OR key = $1 LIMIT 1`, [key]);
  await pool.query(`UPDATE issues SET sla_snapshot = NULL WHERE id = $1`, [rows[0].id]);
  const res = await fetch(`http://localhost:${PORT}/api/issues/${key}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => null);
  for (const s of (data?.sla || data?.issue?.sla || [])) {
    console.log(`${key} [${s.deptName}]: startedAt=${s.startedAt} dueTime=${s.dueTime} goalDurationMs=${s.goalDurationMs}`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
