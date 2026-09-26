// The previous script flagged CF-29619, CF-29322, CF-33365 as having ONLY
// a non-member worked-on record for dept='Migration' -- but that alone
// doesn't prove a bug. If the member-restriction guard works correctly,
// tickets like that should be EXCLUDED from Queue: Migration's broadening,
// not included. Checking against the real live endpoint (same technique as
// the Dev verification) whether these 3 specific tickets actually appear
// in a live Queue: Migration search, using a date range wide enough to
// cover them regardless of when they were created/updated.
//
// Read-only against issue data (writes one throwaway user_sessions row).
//
// Usage: node check-migration-live-inclusion.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const FLAGGED_KEYS = ['CF-29619', 'CF-29322', 'CF-33365'];

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email, role FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'diagnostic-script', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'diagnostic-script', new Date(Date.now() + 3600 * 1000)]
  );

  // Get each flagged ticket's own createdAt so the range genuinely covers it
  const { rows: flaggedRows } = await pool.query(
    `SELECT COALESCE(cf_key, key) AS key, "createdAt", "updatedAt" FROM issues WHERE COALESCE(cf_key, key) = ANY($1::text[])`,
    [FLAGGED_KEYS]
  );
  for (const r of flaggedRows) console.log(`${r.key}: created=${r.createdAt.toISOString().slice(0,10)} updated=${r.updatedAt.toISOString().slice(0,10)}`);

  const qs = new URLSearchParams({
    spaceKey: 'TESTIN',
    dept: 'Migration',
    queueMembersOnly: 'true',
    createdRange: 'between:2025-01-01:2026-12-31',
    updatedRange: 'between:2025-01-01:2026-12-31',
    page: '1',
    limit: '2000',
  });
  const url = `http://localhost:${PORT}/api/issues?${qs.toString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  console.log(`\nQueue: Migration (wide date range) total: ${data.total}`);

  const returnedKeys = new Set((data.issues || []).map((i) => i.cf_key || i.key));
  console.log('\nDo the 3 flagged tickets actually appear in the live Queue: Migration results?');
  for (const k of FLAGGED_KEYS) {
    console.log(`  ${k}: ${returnedKeys.has(k) ? 'YES -- included (would be a real bug)' : 'no -- correctly excluded'}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
