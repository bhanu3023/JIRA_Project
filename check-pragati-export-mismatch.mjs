// Replay the user's exact filter combination (Queue: Dev, Assignee:
// Pragati, Created/Updated: Sep 2026) with both the screen's own limit
// (100) and the export's (2000), to find the real divergence. Read-only.
//
// Usage: node check-pragati-export-mismatch.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: pragati } = await pool.query(`SELECT id, "firstName", "lastName", email FROM users WHERE "firstName" ILIKE 'pragati%' LIMIT 3`);
  console.log('Matching users:', JSON.stringify(pragati));
  if (!pragati.length) { console.log('No match'); await pool.end(); return; }
  const assigneeId = pragati[0].id;

  const { rows: users } = await pool.query(`SELECT id FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'pragati-mismatch-script', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'pragati-mismatch-script', new Date(Date.now() + 3600 * 1000)]
  );

  const baseParams = {
    spaceKey: 'TESTIN', dept: 'Dev', queueMembersOnly: 'true',
    assignees: assigneeId,
    createdRange: 'between:2026-09-01:2026-09-30',
    updatedRange: 'between:2026-09-01:2026-09-30',
    includeTimeSpent: 'true',
  };

  const results = [];
  for (const [label, limit, page] of [['screen page1 (limit=100)', '100', '1'], ['export (limit=2000)', '2000', '1']]) {
    const qs = new URLSearchParams({ ...baseParams, page, limit });
    const res = await fetch(`http://localhost:${PORT}/api/issues?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => null);
    console.log(`\n[${label}] HTTP ${res.status}, total=${data?.total}, returned rows=${(data?.issues || []).length}`);
    results.push({ label, keys: (data?.issues || []).map((i) => i.cfKey || i.key) });
  }

  if (results.length === 2) {
    const [a, b] = results;
    const onlyInA = a.keys.filter((k) => !b.keys.includes(k));
    const onlyInB = b.keys.filter((k) => !a.keys.includes(k));
    console.log(`\nOnly in "${a.label}": ${JSON.stringify(onlyInA)}`);
    console.log(`Only in "${b.label}": ${JSON.stringify(onlyInB)}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
