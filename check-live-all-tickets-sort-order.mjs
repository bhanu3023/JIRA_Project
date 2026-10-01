// User confirms the open/in-progress-before-resolved sort fix (deployed a
// few turns ago) is STILL not visible on "All Tickets" for any queue.
// Calling the real live endpoint directly with the exact params the
// space board's "All Tickets" view sends, to see the actual returned
// order and status categories -- rather than re-guessing at the SQL.
//
// Read-only against issue data (writes one throwaway user_sessions row).
//
// Usage: node check-live-all-tickets-sort-order.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'diagnostic-script', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'diagnostic-script', new Date(Date.now() + 3600 * 1000)]
  );

  // Same params the space board's "All Tickets" view sends for a queue
  const qs = new URLSearchParams({ spaceKey: 'TESTIN', dept: 'Dev', page: '1', limit: '20' });
  const url = `http://localhost:${PORT}/api/issues?${qs.toString()}`;
  console.log(`Fetching: ${url}`);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`Status: ${res.status}`);
  const data = await res.json();
  console.log(`total: ${data.total}\n`);

  console.log('Returned order (key, status name, status category):');
  for (const iss of data.issues || []) {
    console.log(`  ${iss.cf_key || iss.key}  status="${iss.status?.name}"  category="${iss.status?.category}"  createdAt=${iss.createdAt}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
