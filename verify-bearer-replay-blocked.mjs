// Self-contained verification for the Bearer-replay fix (jira-pg-api.ts's
// resolveUserId, admin-auth.ts's requireAdmin): mints a real session the
// same way login does (signs a JWT with the app's own JWT_SECRET, records
// it in user_sessions exactly like login does), then hits a real endpoint
// two ways -- once as the cookie (should work, 200) and once as a raw
// Authorization header (should now be blocked, 401). No browser/DevTools
// needed; run this with `docker exec jira_app node verify-bearer-replay-blocked.mjs`
// so it has the real JWT_SECRET from the container's own environment.
import pg from 'pg';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const BASE = 'http://localhost:8080';

async function main() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET not set in this container -- cannot mint a real token.');

  const { rows } = await pool.query(
    `SELECT id, email FROM users WHERE "isActive" = true ORDER BY "createdAt" ASC LIMIT 1`,
  );
  if (!rows.length) throw new Error('No active user found to test with.');
  const user = rows[0];
  console.log(`Testing as: ${user.email} (${user.id})`);

  const payload = { sub: user.id, ip: '127.0.0.1', ua: 'verify-script', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 3600 * 1000);
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, expiresAt],
  );

  // 1. As the cookie -- this is the legitimate path, should succeed.
  const cookieRes = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: `jira_session=${token}` } });
  console.log(`As cookie (legitimate browser path):   ${cookieRes.status} ${cookieRes.status === 200 ? '✅ works as expected' : '❌ UNEXPECTED — should be 200'}`);

  // 2. As a raw Authorization header -- this is the replay attack this fix blocks.
  const headerRes = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`As raw Bearer header (replay attack):  ${headerRes.status} ${headerRes.status === 401 ? '✅ correctly BLOCKED' : '❌ NOT BLOCKED — fix is not working'}`);

  // Clean up the test session row.
  await pool.query(`DELETE FROM user_sessions WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
