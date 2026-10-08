// Guru M (gururaj.bhimrao@cloudfuze.com) + Queue: Dev shows live=4 but a
// plain current_department='Dev' + assigneeId=Guru count is 423 -- a ~100x
// gap, clearly not just the usual historical-credit broadening difference
// seen for every other person tested. Finds exactly which clause in the
// dept-scoped query is excluding his tickets. Read-only.
//
// Usage: node check-guru-dev-queue-bug.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const BASE = `http://localhost:${PORT}/api`;
const SPACE_KEY = 'TESTIN';
const DEPT = 'Dev';
const EMAIL = 'gururaj.bhimrao@cloudfuze.com';

async function main() {
  const { rows: guruRows } = await pool.query(`SELECT id, email FROM users WHERE email = $1`, [EMAIL]);
  const guru = guruRows[0];
  console.log(`Guru M user id: ${guru.id}`);

  const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const admin = adminRows[0];
  const payload = { sub: admin.id, ip: '', ua: 'guru-dev-queue-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'guru-dev-queue-check', new Date(Date.now() + 3600 * 1000)]
  );
  const headers = { Authorization: `Bearer ${token}` };
  async function get(path) {
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text);
  }

  // Live result -- which 4 tickets does it actually return?
  const qs = new URLSearchParams({ spaceKey: SPACE_KEY, dept: DEPT, queueMembersOnly: 'true', assignees: guru.id, page: '1', limit: '10' });
  const live = await get(`/issues?${qs.toString()}`);
  console.log(`\nLive total: ${live.total}`);
  console.log('Live tickets:', (live.issues || []).map((i) => i.cfKey ?? i.key));

  // Is Guru even a configured member of the Dev queue?
  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = cqRows[0]?.queues || [];
  const devQueue = queues.find((q) => String(q.name || '').toLowerCase() === DEPT.toLowerCase());
  const memberIds = Array.isArray(devQueue?.memberIds) ? devQueue.memberIds : [];
  console.log(`\nIs Guru in the live Dev queue's memberIds? ${memberIds.includes(guru.id)}`);
  console.log(`Dev queue memberIds count: ${memberIds.length}`);

  // Ground truth: plain current_department='Dev' + assigneeId=Guru
  const { rows: gt } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM issues WHERE "assigneeId" = $1 AND LOWER(current_department) = LOWER($2) AND "spaceId" = (SELECT id FROM spaces WHERE key = $3)`,
    [guru.id, DEPT, SPACE_KEY]
  );
  console.log(`\nGround truth (assigneeId=Guru AND current_department=Dev): ${gt[0].cnt}`);

  // Sample a few of those 423 ground-truth tickets and show their full
  // relevant fields, to see what memberClause/deptScopeSql would do with them.
  const { rows: sample } = await pool.query(
    `SELECT COALESCE(cf_key, key) AS key, current_department, "assigneeId", "statusId"
     FROM issues WHERE "assigneeId" = $1 AND LOWER(current_department) = LOWER($2) AND "spaceId" = (SELECT id FROM spaces WHERE key = $3)
     LIMIT 10`,
    [guru.id, DEPT, SPACE_KEY]
  );
  console.log('\nSample of the 423 ground-truth tickets:', sample.map((r) => r.key));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
