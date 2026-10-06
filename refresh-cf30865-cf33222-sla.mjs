// CF-30865 and CF-33222 got their priority corrected manually (not
// through either bulk script), so they never matched the issue_history
// marker the bulk refresh selected on -- their frozen sla_snapshot
// still reflects the old broken 0h goal. Clears it and calls the real
// GET endpoint directly for just these two, same mechanism as the bulk
// refresh. Always applies (only 2 tickets, already fully verified safe
// at scale).
//
// Usage: node refresh-cf30865-cf33222-sla.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const KEYS = ['CF-30865', 'CF-33222'];

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'sla-refresh-two', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'sla-refresh-two', new Date(Date.now() + 3600 * 1000)]
  );

  for (const key of KEYS) {
    const { rows } = await pool.query(`SELECT id FROM issues WHERE cf_key = $1 OR key = $1 LIMIT 1`, [key]);
    if (!rows.length) { console.log(`${key}: not found`); continue; }
    await pool.query(`UPDATE issues SET sla_snapshot = NULL WHERE id = $1`, [rows[0].id]);
    const res = await fetch(`http://localhost:${PORT}/api/issues/${key}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => null);
    const migrationSla = (data?.sla || data?.issue?.sla || []).find((s) => s.deptName?.toLowerCase() === 'migration');
    console.log(`${key}: HTTP ${res.status} -- startedAt=${migrationSla?.startedAt} dueTime=${migrationSla?.dueTime} goalDurationMs=${migrationSla?.goalDurationMs}`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
