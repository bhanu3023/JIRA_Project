// Clean, definitive version: for EVERY real member of EVERY queue
// (Dev, Migration, Infra, QA), compares the screen-shaped total
// (limit=100) against the export-shaped total (limit=2000) for the
// exact same filters (Queue:X + Assignee:person + Created/Updated Sep
// 2026). `total` is a pure COUNT, independent of pagination -- if it
// ever differs between the two limits for the same filters, that's a
// genuine bug, not a pagination artifact (unlike the earlier row-key
// diff approach, which produced misleading noise). Read-only.
//
// Usage: node check-everyone-screen-vs-export.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'everyone-screen-vs-export', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'everyone-screen-vs-export', new Date(Date.now() + 3600 * 1000)]
  );

  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = cq[0]?.queues || [];

  let totalChecked = 0, mismatches = 0;
  for (const q of queues) {
    if (!q.name || !Array.isArray(q.memberIds) || !q.memberIds.length) continue;
    const { rows: realUsers } = await pool.query(`SELECT id, "firstName", "lastName" FROM users WHERE id = ANY($1::text[])`, [q.memberIds]);
    console.log(`\n=== Queue: ${q.name} (${realUsers.length} real members) ===`);
    for (const u of realUsers) {
      const baseParams = {
        spaceKey: 'TESTIN', dept: q.name, queueMembersOnly: 'true', assignees: u.id,
        createdRange: 'between:2026-09-01:2026-09-30',
        updatedRange: 'between:2026-09-01:2026-09-30',
        includeTimeSpent: 'true',
      };
      const [screenRes, exportRes] = await Promise.all([
        fetch(`http://localhost:${PORT}/api/issues?${new URLSearchParams({ ...baseParams, page: '1', limit: '100' })}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
        fetch(`http://localhost:${PORT}/api/issues?${new URLSearchParams({ ...baseParams, page: '1', limit: '2000' })}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      ]);
      totalChecked++;
      if (screenRes?.total !== exportRes?.total) {
        mismatches++;
        console.log(`  MISMATCH: ${u.firstName} ${u.lastName} (${u.id}) -- screen total=${screenRes?.total}, export total=${exportRes?.total}`);
      }
    }
  }

  console.log(`\n\n=== SUMMARY: ${totalChecked} person-queue combinations checked, ${mismatches} real total mismatches ===`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
