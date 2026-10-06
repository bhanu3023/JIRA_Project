// "All Work" tab = Filters page with NO Queue selected -- goes through a
// DIFFERENT code path (the general Prisma where-clause branch) than every
// Queue-scoped test done so far this session. Checking whether applying
// filters there actually narrows the count at all (vs staying stuck at
// the same total, which is what "not working dynamically" would look
// like), and whether the baseline matches a raw DB count. Read-only.
//
// Usage: node check-allwork-filters-dynamic.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'allwork-dynamic-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'allwork-dynamic-check', new Date(Date.now() + 3600 * 1000)]
  );

  async function fetchTotal(extra, label) {
    const qs = new URLSearchParams({ spaceKey: 'TESTIN', includeTimeSpent: 'true', ...extra, page: '1', limit: '1' });
    const res = await fetch(`http://localhost:${PORT}/api/issues?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => null);
    console.log(`[${label}] total=${data?.total} (HTTP ${res.status})`);
    return data?.total;
  }

  console.log('--- "All Work" tab (no Queue selected), applying ONE filter at a time ---');
  const baseline = await fetchTotal({}, 'no filters at all');

  const { rows: dbTotal } = await pool.query(`SELECT COUNT(*)::int AS cnt FROM issues i JOIN spaces sp ON sp.id = i."spaceId" WHERE sp.key = 'TESTIN'`);
  console.log(`  raw DB COUNT(*) for TESTIN: ${dbTotal[0].cnt}`);

  await fetchTotal({ status: 'Open' }, 'Status: Open');
  await fetchTotal({ status: 'Resolved' }, 'Status: Resolved');
  await fetchTotal({ priority: 'Highest' }, 'Priority: Highest');
  await fetchTotal({ createdRange: 'between:2026-09-01:2026-09-30' }, 'Created: Sep 2026');

  const { rows: someAssignee } = await pool.query(`SELECT "assigneeId" FROM issues i JOIN spaces sp ON sp.id = i."spaceId" WHERE sp.key = 'TESTIN' AND i."assigneeId" IS NOT NULL LIMIT 1`);
  if (someAssignee.length) {
    await fetchTotal({ assignees: someAssignee[0].assigneeId }, `Assignee: ${someAssignee[0].assigneeId}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
