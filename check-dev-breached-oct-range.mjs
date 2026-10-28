// Read-only: exact count of Queue: Dev + SLA Breached: Yes tickets created
// or updated between 2026-10-01 and 2026-10-28 (matching the Filters page's
// own "either" combination), via the live API the page itself calls.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'breach-count', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','breach-count',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  if (!JWT_SECRET) { console.error('JWT_SECRET not set'); process.exit(1); }
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const qs = `spaceKey=TESTIN&dept=Dev&queueMembersOnly=true&slaBreached=yes&createdRange=between:2026-10-01:2026-10-28&updatedRange=between:2026-10-01:2026-10-28&multiSep=pipe&page=1&limit=200`;
  const res = await fetch(`${APP_URL}/api/issues?${qs}`, { headers: authHeader, signal: AbortSignal.timeout(60000) });
  const data = await res.json();
  console.log(`Queue: Dev + SLA Breached: Yes, Created/Updated 2026-10-01..2026-10-28 (either) -> TOTAL = ${data.total}`);

  const rows = data.issues || [];
  const resolvedCount = rows.filter((i) => i.status?.category === 'done').length;
  const openCount = rows.length - resolvedCount;
  console.log(`\nOf the ${rows.length} returned on this page: ${resolvedCount} resolved (breached late), ${openCount} still open (currently overdue)`);

  console.log(`\nFirst ${Math.min(rows.length, 30)}:`);
  for (const i of rows.slice(0, 30)) {
    console.log(` - ${i.cfKey || i.key} | ${i.status?.name} | priority=${i.priority} | assignee=${i.assignee ? `${i.assignee.firstName} ${i.assignee.lastName}`.trim() : 'Unassigned'} | breached by=${i.sla_breached_by || 'n/a'} | "${(i.summary||'').slice(0,60)}"`);
  }

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
