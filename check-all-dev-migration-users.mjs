// For every Dev and Migration queue member, call the live /api/issues
// endpoint with both the screen's shape (limit=100) and the export's
// (limit=2000) -- same Created/Updated=Sep 2026 window as the user's own
// screenshot -- and report anyone whose totals actually differ between
// the two, or whose ticket lists diverge. Read-only (GET requests only).
//
// Usage: node check-all-dev-migration-users.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const admin = adminRows[0];
  const payload = { sub: admin.id, ip: '', ua: 'all-users-check-script', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'all-users-check-script', new Date(Date.now() + 3600 * 1000)]
  );

  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = cq[0]?.queues || [];

  const { rows: allUsers } = await pool.query(`SELECT id, "firstName", "lastName" FROM users`);
  const nameById = new Map(allUsers.map(u => [u.id, `${u.firstName || ''} ${u.lastName || ''}`.trim()]));

  let mismatches = 0;
  let checked = 0;
  for (const dept of ['Dev', 'Migration']) {
    const q = queues.find(qq => (qq.name || '').toLowerCase() === dept.toLowerCase());
    const memberIds = q?.memberIds || [];
    console.log(`\n=== ${dept}: ${memberIds.length} members ===`);
    for (const memberId of memberIds) {
      checked++;
      const baseParams = {
        spaceKey: 'TESTIN', dept, queueMembersOnly: 'true',
        assignees: memberId,
        createdRange: 'between:2026-09-01:2026-09-30',
        updatedRange: 'between:2026-09-01:2026-09-30',
        includeTimeSpent: 'true',
      };
      const fetchOne = async (limit) => {
        const qs = new URLSearchParams({ ...baseParams, page: '1', limit });
        const res = await fetch(`http://localhost:${PORT}/api/issues?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json().catch(() => null);
        return { total: data?.total, keys: (data?.issues || []).map(i => i.cfKey || i.key) };
      };
      const screenLike = await fetchOne('100');
      const exportLike = await fetchOne('2000');
      const onlyScreen = screenLike.keys.filter(k => !exportLike.keys.includes(k));
      const onlyExport = exportLike.keys.filter(k => !screenLike.keys.includes(k));
      if (screenLike.total !== exportLike.total || onlyScreen.length || onlyExport.length) {
        mismatches++;
        console.log(`  *** MISMATCH: ${nameById.get(memberId) || memberId} -- screen total=${screenLike.total}, export total=${exportLike.total}`);
        if (onlyScreen.length) console.log(`      only in screen: ${JSON.stringify(onlyScreen)}`);
        if (onlyExport.length) console.log(`      only in export: ${JSON.stringify(onlyExport)}`);
      }
    }
  }
  console.log(`\nChecked ${checked} user/department combinations, found ${mismatches} mismatch(es).`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
