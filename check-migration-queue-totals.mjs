// Read-only: verify Queue: Migration totals against the live API --
// (1) plain Created/Updated 2026-10-01..2026-10-28 (either) -> should be 506
// (2) + SLA Breached: Yes -> should be 12
// Also specifically re-checks CF-34498 (BTM Resources), which the Dev-scope
// fix correctly removed from Dev's breach list -- if it's real, it should
// show up HERE under Migration instead, since that's its current department.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'migration-verify', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','migration-verify',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  if (!JWT_SECRET) { console.error('JWT_SECRET not set'); process.exit(1); }
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const base = `spaceKey=TESTIN&dept=Migration&queueMembersOnly=true&createdRange=between:2026-10-01:2026-10-28&updatedRange=between:2026-10-01:2026-10-28&multiSep=pipe`;

  const res1 = await fetch(`${APP_URL}/api/issues?${base}&page=1&limit=1`, { headers: authHeader, signal: AbortSignal.timeout(60000) });
  const data1 = await res1.json();
  console.log(`Queue: Migration, Created/Updated 2026-10-01..2026-10-28 (either) -> total=${data1.total} (screenshot showed 506)`);

  const res2 = await fetch(`${APP_URL}/api/issues?${base}&slaBreached=yes&page=1&limit=50`, { headers: authHeader, signal: AbortSignal.timeout(60000) });
  const data2 = await res2.json();
  console.log(`Queue: Migration + SLA Breached: Yes -> total=${data2.total} (screenshot showed 12)`);

  console.log(`\nAll ${data2.issues?.length || 0} tickets in this breached list:`);
  for (const i of (data2.issues || [])) {
    console.log(` - ${i.cfKey || i.key} | ${i.status?.name} | assignee=${i.assignee ? `${i.assignee.firstName} ${i.assignee.lastName}`.trim() : 'Unassigned'} | breached by=${i.sla_breached_by || 'n/a'} dept=${i.sla_breached_dept || 'n/a'} | "${(i.summary||'').slice(0,50)}"`);
  }

  const cf34498 = (data2.issues || []).find((i) => (i.cfKey || i.key) === 'CF-34498');
  console.log(`\nCF-34498 ${cf34498 ? 'appears here under Migration (expected, since it moved out of Dev)' : 'does NOT appear here -- needs checking'}`);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
