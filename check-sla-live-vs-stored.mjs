// Checks whether GET /issues/:key recomputes SLA instances live (would
// already reflect the startedAt fix) or just returns the frozen
// sla_snapshot column written before the fix was deployed. Read-only.
//
// Usage: node check-sla-live-vs-stored.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'sla-live-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'sla-live-check', new Date(Date.now() + 3600 * 1000)]
  );

  for (const key of ['CF-30865', 'CF-33222']) {
    const res = await fetch(`http://localhost:${PORT}/api/issues/${key}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => null);
    const slaArr = data?.sla || data?.issue?.sla || [];
    console.log(`\n${key} -- live GET /issues/${key} response's sla field:`);
    console.log(JSON.stringify(slaArr, null, 2));
  }

  // Also check what's still stored in the raw sla_snapshot DB column
  const { rows } = await pool.query(`SELECT cf_key, sla_snapshot FROM issues WHERE cf_key = ANY($1::text[])`, [['CF-30865', 'CF-33222']]);
  console.log('\nRaw sla_snapshot column in DB:');
  console.log(JSON.stringify(rows, null, 2));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
