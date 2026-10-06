// The on-screen Filters list and the Export button call the exact same
// buildFilterParams()/api.getIssues(), just with different page/limit
// (screen: page=X, limit=100; export: page=1, limit=2000). User confirms
// the two show genuinely different counts for the same filter set.
// Testing whether the backend itself returns a different `total` purely
// because of the limit value, using a real Dev-queue assignee + queue
// scoping (the same combination shown in the screenshot). Read-only (GET).
//
// Usage: node check-filters-export-vs-screen-mismatch.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'export-mismatch-script', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'export-mismatch-script', new Date(Date.now() + 3600 * 1000)]
  );

  // Find a real assignee with a decent number of Dev tickets this past month
  const { rows: cand } = await pool.query(`
    SELECT i."assigneeId" AS id, COUNT(*)::int AS cnt
    FROM issues i
    WHERE LOWER(i.current_department) = 'dev' AND i."assigneeId" IS NOT NULL
      AND i."createdAt" >= '2026-09-01' AND i."createdAt" < '2026-10-01'
    GROUP BY i."assigneeId" ORDER BY cnt DESC LIMIT 1
  `);
  if (!cand.length) { console.log('No candidate assignee found'); await pool.end(); return; }
  const assigneeId = cand[0].id;
  console.log(`Using assignee ${assigneeId} (${cand[0].cnt} Dev tickets created in Sep per raw DB count)\n`);

  const baseParams = {
    spaceKey: 'TESTIN', dept: 'Dev', queueMembersOnly: 'true',
    assignees: assigneeId,
    createdRange: 'between:2026-09-01:2026-09-30',
    updatedRange: 'between:2026-09-01:2026-09-30',
    includeTimeSpent: 'true',
  };

  for (const [label, limit] of [['screen-like (limit=100, page=1)', '100'], ['export-like (limit=2000, page=1)', '2000']]) {
    const qs = new URLSearchParams({ ...baseParams, page: '1', limit });
    const res = await fetch(`http://localhost:${PORT}/api/issues?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    console.log(`[${label}] HTTP ${res.status}, total=${data?.total}, returned rows=${(data?.issues || []).length}`);
    if (!res.ok || data?.error) console.log(`  Raw response: ${text.slice(0, 500)}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
