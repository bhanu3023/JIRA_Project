// Replicates both the board's quick-filter (dept=Infra, status=Open,In
// Progress) and the Filters page's exact config from the screenshot
// (dept=Infra, status=Open,In Progress,Routed to Infra, PLUS the inert
// "department=infra" extra filter) to see exactly how much each extra
// status/filter contributes, and whether "department" param does
// anything at all server-side. Read-only.
//
// Usage: node check-infra-status-mismatch.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'infra-status-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'infra-status-check', new Date(Date.now() + 3600 * 1000)]
  );

  const scenarios = [
    ['board: status=Open,In Progress', { spaceKey: 'TESTIN', dept: 'Infra', queueMembersOnly: 'true', status: 'Open,In Progress' }],
    ['filters: status=Open,In Progress,Routed to Infra', { spaceKey: 'TESTIN', dept: 'Infra', queueMembersOnly: 'true', status: 'Open,In Progress,Routed to Infra' }],
    ['filters + inert department=infra param', { spaceKey: 'TESTIN', dept: 'Infra', queueMembersOnly: 'true', status: 'Open,In Progress,Routed to Infra', department: 'infra' }],
    ['status=Routed to Infra ONLY', { spaceKey: 'TESTIN', dept: 'Infra', queueMembersOnly: 'true', status: 'Routed to Infra' }],
  ];

  for (const [label, extra] of scenarios) {
    const qs = new URLSearchParams({ ...extra, page: '1', limit: '1' });
    const res = await fetch(`http://localhost:${PORT}/api/issues?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => null);
    console.log(`[${label}] total=${data?.total} (HTTP ${res.status})`);
  }

  // Also: does a bogus 'department' value (should be a no-op) actually change
  // anything at all vs not sending it?
  const a = await fetch(`http://localhost:${PORT}/api/issues?${new URLSearchParams({ spaceKey: 'TESTIN', dept: 'Infra', queueMembersOnly: 'true', status: 'Open,In Progress', page: '1', limit: '1' })}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
  const b = await fetch(`http://localhost:${PORT}/api/issues?${new URLSearchParams({ spaceKey: 'TESTIN', dept: 'Infra', queueMembersOnly: 'true', status: 'Open,In Progress', department: 'this-value-should-not-exist-anywhere', page: '1', limit: '1' })}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
  console.log(`\nWithout department param: total=${a?.total}`);
  console.log(`With a nonsense department param (should be identical if it's truly inert): total=${b?.total}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
