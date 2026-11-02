// Read-only: verify the real /api/issues total for Queue: Migration,
// Created OR Resolved date between 2026-10-26 and 2026-11-02, matches what
// Filters displayed (139), and spot-check a sample of returned tickets'
// actual createdAt/resolvedAt fall genuinely within that range.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'migration-total-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','migration-total-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const url = `${APP_URL}/api/issues?spaceKey=TESTIN&dept=Migration&queueMembersOnly=true&createdRange=between:2026-10-26:2026-11-02&resolvedRange=between:2026-10-26:2026-11-02&page=1&limit=500`;
  const res = await fetch(url, { headers: authHeader, signal: AbortSignal.timeout(60000) });
  const data = await res.json();
  console.log('Total returned by live API:', data.total, '| issues array length:', (data.issues || []).length);

  const from = new Date('2026-10-26T00:00:00+05:30');
  const to = new Date('2026-11-02T23:59:59.999+05:30');
  let outOfRange = 0;
  for (const issue of data.issues || []) {
    const created = new Date(issue.createdAt);
    const resolved = issue.resolvedAt ? new Date(issue.resolvedAt) : null;
    const inRange = (created >= from && created <= to) || (resolved && resolved >= from && resolved <= to);
    if (!inRange) {
      outOfRange++;
      console.log(` - OUT OF RANGE: ${issue.cfKey || issue.key} createdAt=${issue.createdAt} resolvedAt=${issue.resolvedAt}`);
    }
  }
  console.log(`\nTickets genuinely outside the Created-OR-Resolved range: ${outOfRange} / ${(data.issues || []).length}`);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
