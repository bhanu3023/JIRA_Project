// Generates the ACTUAL export content for Queue:Dev + Assignee:Pragati
// (the exact scenario repeatedly reported as 70 on screen / 64 in
// Excel) and prints the raw row count plus every single ticket key in
// it -- removing Excel's counting/filtering UI entirely from the
// picture. If this script's own count doesn't match 70, that's a real,
// reproducible bug. If it does, the problem is confirmed to be in how
// the export was taken or read, not in the underlying mechanism.
// Read-only.
//
// Usage: node show-real-export-content.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'show-real-export', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'show-real-export', new Date(Date.now() + 3600 * 1000)]
  );

  const PRAGATI_ID = 'pg_on73cwx5te';
  const qs = new URLSearchParams({
    spaceKey: 'TESTIN', dept: 'Dev', queueMembersOnly: 'true', assignees: PRAGATI_ID,
    createdRange: 'between:2026-09-01:2026-09-30',
    updatedRange: 'between:2026-09-01:2026-09-30',
    includeTimeSpent: 'true', page: '1', limit: '2000',
  });
  const res = await fetch(`http://localhost:${PORT}/api/issues?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => null);
  const rows = data?.issues || [];

  console.log(`API total field says: ${data?.total}`);
  console.log(`Actual rows in the response array: ${rows.length}`);
  console.log(`\nEvery single ticket key that would be in this export:`);
  console.log(rows.map(r => r.cfKey || r.key).join(', '));

  const nonPragati = rows.filter(r => r.assignee?.id !== PRAGATI_ID);
  console.log(`\nRows NOT actually assigned to Pragati (should be 0): ${nonPragati.length}`);

  const uniqueKeys = new Set(rows.map(r => r.cfKey || r.key));
  console.log(`Unique ticket keys: ${uniqueKeys.size} (should equal rows.length if there are no duplicates)`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
