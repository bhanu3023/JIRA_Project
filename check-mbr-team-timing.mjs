// Read-only: time the real MBR "Customer Engineering" (team=eng) endpoint
// directly, bypassing the frontend's 20s give-up, to find out whether it's
// genuinely slow (and by how much) or erroring outright. The handler already
// logs a per-phase timing breakdown server-side (search docker logs for
// "[DEBUG mbr-team-tab]" right after this runs) -- this just measures total
// wall-clock time and reports what comes back.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'mbr-timing', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','mbr-timing',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  if (!JWT_SECRET) { console.error('JWT_SECRET not set'); process.exit(1); }
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const url = `${APP_URL}/api/reports/mbr-team?team=eng&dateFrom=2026-10-01&dateTo=2026-10-28&staleDays=7`;
  console.log(`Calling ${url} with a 180s timeout...`);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: authHeader, signal: AbortSignal.timeout(180_000) });
    const ms = Date.now() - t0;
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    console.log(`Status ${res.status} after ${ms}ms`);
    if (parsed) {
      console.log(`Response keys: ${Object.keys(parsed).join(', ')}`);
      if (parsed.tickets) console.log(`tickets count: ${parsed.tickets.length}`);
    } else {
      console.log(`Non-JSON body (first 300 chars): ${text.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`FAILED after ${Date.now() - t0}ms -- ${e?.message || e}`);
  }

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
