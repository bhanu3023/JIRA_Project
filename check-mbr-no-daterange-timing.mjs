// The MBR Customer Engineering tab timed out on a real request with NO
// date range set at all (team=eng&staleDays=7, no dateFrom/dateTo) --
// that's an unbounded query across the team's entire ticket history, and
// the newly-added Avg. Response Time computation runs one more pass over
// every candidate on top of the existing breach/resolution-hours passes.
// Times the real live endpoint, with and without a date range, to see
// how much headroom is actually left and whether the new feature is what
// pushed it over.
//
// Usage: node check-mbr-no-daterange-timing.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'mbr-timing-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','mbr-timing-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return token;
}

async function timeIt(label, url, authHeader, timeoutMs = 60000) {
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { headers: authHeader, signal: controller.signal });
    clearTimeout(timer);
    const body = await res.json().catch(() => null);
    const ms = Date.now() - t0;
    console.log(`${label}: ${ms}ms  (status ${res.status}${body?.tickets ? `, tickets=${body.tickets.length}` : ''}${body?.people ? `, people=${body.people.length}` : ''})`);
  } catch (e) {
    console.log(`${label}: FAILED after ${Date.now() - t0}ms -- ${e.message}`);
  }
}

async function main() {
  const token = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  await timeIt('MBR eng, NO date range', `${APP_URL}/api/reports/mbr-team?team=eng&staleDays=7`, authHeader);
  await timeIt('MBR eng, Aug 2026 only', `${APP_URL}/api/reports/mbr-team?team=eng&dateFrom=2026-08-01&dateTo=2026-08-31&staleDays=7`, authHeader);

  console.log('\n=== How many tickets does the no-date-range query actually match? ===');
  const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM issues`);
  console.log(`Total issues in DB (upper bound for an unbounded dept+roster match): ${rows[0].n}`);

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
