// Cross-check against the Infra/QA investigation: Migration and Dev DO
// have real sla_definitions configured, so their open tickets should
// correctly show an active "sla" array (unlike Infra/QA's correctly-empty
// one). Confirming via the same live endpoint. Read-only.
//
// Usage: node check-migration-dev-live-sla.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'sla-verify-script', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'sla-verify-script', new Date(Date.now() + 3600 * 1000)]
  );

  const { rows: tix } = await pool.query(
    `SELECT key, cf_key, current_department FROM issues
     WHERE LOWER(current_department) IN ('migration','dev') AND "resolvedAt" IS NULL
     ORDER BY "createdAt" DESC LIMIT 4`
  );
  for (const t of tix) {
    const key = t.cf_key || t.key;
    const res = await fetch(`http://localhost:${PORT}/api/issues/${key}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    console.log(`\n${key} (dept=${t.current_department}):`);
    console.log('sla:', JSON.stringify(data.sla?.map((s) => ({ policyName: s.policyName, deptName: s.deptName, isBreached: s.isBreached, isPaused: s.isPaused, dueTime: s.dueTime, goalDurationMs: s.goalDurationMs })), null, 2));
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
