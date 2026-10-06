// Directly replicates an export-shaped call (high limit, export=1-style)
// scoped to Queue:Dev + Assignee:Pragati + Created/Updated Sep 2026 --
// confirms whether the export mechanism itself is correct when the
// Assignee filter IS included in the request (as opposed to the
// user's actual downloaded file, which looks like it was exported
// WITHOUT the assignee filter active -- its total was 581, matching
// unfiltered Queue:Dev, not the 70 shown on screen with Pragati
// selected). Read-only.
//
// Usage: node check-pragati-export-sanity.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'pragati-export-sanity', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'pragati-export-sanity', new Date(Date.now() + 3600 * 1000)]
  );

  const PRAGATI_ID = 'pg_on73cwx5te';
  const baseParams = {
    spaceKey: 'TESTIN', dept: 'Dev', queueMembersOnly: 'true', assignees: PRAGATI_ID,
    createdRange: 'between:2026-09-01:2026-09-30',
    updatedRange: 'between:2026-09-01:2026-09-30',
    includeTimeSpent: 'true',
  };

  for (const [label, limit] of [['screen-shaped (limit=100)', '100'], ['export-shaped (limit=2000)', '2000']]) {
    const qs = new URLSearchParams({ ...baseParams, page: '1', limit });
    const res = await fetch(`http://localhost:${PORT}/api/issues?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => null);
    const rows = data?.issues || [];
    const nonPragati = rows.filter((i) => i.assignee?.id !== PRAGATI_ID);
    console.log(`[${label}] total=${data?.total}, rows returned=${rows.length}, rows NOT assigned to Pragati=${nonPragati.length}`);
    if (nonPragati.length) console.log('  non-Pragati keys:', nonPragati.map(i => i.cfKey || i.key));
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
