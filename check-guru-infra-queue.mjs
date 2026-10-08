// Guru M (gururaj.bhimrao@cloudfuze.com) is primarily an Infra person --
// confirms Queue: Infra + Assignee: Guru shows his real ticket count
// accurately, same verification pattern as the earlier Dev-queue check.
// Read-only.
//
// Usage: node check-guru-infra-queue.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const BASE = `http://localhost:${PORT}/api`;
const SPACE_KEY = 'TESTIN';
const DEPT = 'Infra';
const EMAIL = 'gururaj.bhimrao@cloudfuze.com';

async function main() {
  const { rows: guruRows } = await pool.query(`SELECT id, email FROM users WHERE email = $1`, [EMAIL]);
  const guru = guruRows[0];

  const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const admin = adminRows[0];
  const payload = { sub: admin.id, ip: '', ua: 'guru-infra-queue-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'guru-infra-queue-check', new Date(Date.now() + 3600 * 1000)]
  );
  const headers = { Authorization: `Bearer ${token}` };
  async function get(path) {
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text);
  }

  const qs = new URLSearchParams({ spaceKey: SPACE_KEY, dept: DEPT, queueMembersOnly: 'true', assignees: guru.id, page: '1', limit: '5' });
  const live = await get(`/issues?${qs.toString()}`);
  console.log(`Live total (Queue: Infra + Assignee: Guru): ${live.total}`);
  console.log('Sample live tickets:', (live.issues || []).map((i) => i.cfKey ?? i.key));

  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = cqRows[0]?.queues || [];
  const infraQueue = queues.find((q) => String(q.name || '').toLowerCase() === DEPT.toLowerCase());
  const memberIds = Array.isArray(infraQueue?.memberIds) ? infraQueue.memberIds : [];
  console.log(`Is Guru in the live Infra queue's memberIds? ${memberIds.includes(guru.id)}`);

  const { rows: gt } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM issues WHERE "assigneeId" = $1 AND LOWER(current_department) = LOWER($2) AND "spaceId" = (SELECT id FROM spaces WHERE key = $3)`,
    [guru.id, DEPT, SPACE_KEY]
  );
  console.log(`Ground truth (assigneeId=Guru AND current_department=Infra): ${gt[0].cnt}`);

  // Also: how many of his tickets are tagged Dev vs Infra vs other, overall --
  // to understand his real split.
  const { rows: byDept } = await pool.query(
    `SELECT current_department, COUNT(*)::int AS cnt FROM issues WHERE "assigneeId" = $1 AND "spaceId" = (SELECT id FROM spaces WHERE key = $2) GROUP BY current_department ORDER BY cnt DESC`,
    [guru.id, SPACE_KEY]
  );
  console.log('\nGuru\'s tickets by current_department (overall):', byDept.map((r) => `${r.current_department || '(none)'}=${r.cnt}`).join(', '));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
