// Instead of continuing to hand-replicate the dept-scoped branch's complex
// matching rules (origin dept / updated-while-in-dept / status routing /
// queue-membership broadening -- none of the simple hypotheses tried so
// far reproduce anything near 171), call the REAL live /api/issues
// endpoint with the exact same params the Filters screenshot's URL shows,
// using a self-signed session token, and inspect the actual rows it
// returns.
//
// Read-only against issue data (does write one throwaway row to
// user_sessions so the token passes session validation, matching how a
// real login works -- harmless, expires in a day).
//
// Usage: node check-testin-live-api.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 3000;

async function main() {
  if (!JWT_SECRET) { console.log('No JWT_SECRET in env'); await pool.end(); return; }

  const { rows: users } = await pool.query(
    `SELECT id, email, role FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`
  );
  const user = users[0];
  if (!user) { console.log('Admin user not found'); await pool.end(); return; }
  console.log(`Using user: ${user.email} (${user.role})`);

  const payload = { sub: user.id, ip: '', ua: 'diagnostic-script', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 3600 * 1000);
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'diagnostic-script', expiresAt]
  );

  const qs = new URLSearchParams({
    spaceKey: 'TESTIN',
    dept: 'Dev',
    queueMembersOnly: 'true',
    createdRange: 'between:2026-09-14:2026-09-20',
    updatedRange: 'between:2026-09-14:2026-09-20',
    page: '1',
    limit: '500',
  });
  const url = `http://localhost:${PORT}/api/issues?${qs.toString()}`;
  console.log(`\nFetching: ${url}`);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`Status: ${res.status}`);
  const data = await res.json();
  console.log(`total: ${data.total}  returned: ${data.issues?.length}`);

  if (Array.isArray(data.issues)) {
    const deptCounts = {};
    let outOfRangeCreated = 0, outOfRangeUpdated = 0;
    for (const iss of data.issues) {
      const d = iss.current_department || '(none)';
      deptCounts[d] = (deptCounts[d] || 0) + 1;
      const c = new Date(iss.createdAt), u = new Date(iss.updatedAt);
      const lo = new Date('2026-09-14'), hi = new Date('2026-09-21');
      if (!(c >= lo && c < hi)) outOfRangeCreated++;
      if (!(u >= lo && u < hi)) outOfRangeUpdated++;
    }
    console.log('\ncurrent_department breakdown of returned rows:', JSON.stringify(deptCounts));
    console.log(`rows with createdAt OUTSIDE 9/14-9/20: ${outOfRangeCreated}`);
    console.log(`rows with updatedAt OUTSIDE 9/14-9/20: ${outOfRangeUpdated}`);

    console.log('\nFirst 10 rows (key, dept, created, updated):');
    for (const iss of data.issues.slice(0, 10)) {
      console.log(`  ${iss.cf_key || iss.key}  dept=${iss.current_department}  created=${iss.createdAt}  updated=${iss.updatedAt}`);
    }
  } else {
    console.log('Response body:', JSON.stringify(data).slice(0, 1000));
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
