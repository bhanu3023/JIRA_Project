// Verifies the new GET /worklogs?dept=Dev server-side roster filter
// directly against the live endpoint, for the same date range and space
// shown not working in the UI. Confirms all 5 known Dev-roster people's
// entries (Hemadasu Kantam, Ravi Srivastava, Jaswanth Adari, Naved, Vishal
// Kumar) come back, regardless of their own entries' department tag.
// Read-only.
//
// Usage: node check-worklogs-dept-endpoint.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const BASE = `http://localhost:${PORT}/api`;
const DATE_FROM = '2026-09-09';
const DATE_TO = '2026-10-08';
const SPACE_KEY = 'TESTIN';

async function main() {
  const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const admin = adminRows[0];
  const payload = { sub: admin.id, ip: '', ua: 'worklogs-dept-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'worklogs-dept-check', new Date(Date.now() + 3600 * 1000)]
  );
  const headers = { Authorization: `Bearer ${token}` };
  async function get(path) {
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text);
  }

  const qs = new URLSearchParams({
    from: `${DATE_FROM}T00:00:00`, to: `${DATE_TO}T23:59:59`, spaceKey: SPACE_KEY, dept: 'Dev',
  });
  const result = await get(`/worklogs?${qs.toString()}`);
  console.log(`GET /worklogs?dept=Dev for ${SPACE_KEY}, ${DATE_FROM} to ${DATE_TO} -- ${result.length} entries:\n`);
  for (const r of result) {
    console.log(`  ${r.issueKey}: ${r.authorName} -- department tag="${r.department}", ${r.timeSpentMinutes}min, ${new Date(r.workDate).toISOString().slice(0, 10)}`);
  }

  const EXPECTED_NAMES = ['Hemadasu Kantam', 'Ravi Srivastava', 'Adari Venkata Jaswanth', 'Naved', 'Vishal Kumar'];
  const foundNames = new Set(result.map((r) => r.authorName));
  console.log('\nExpected Dev-roster people found in result:');
  for (const name of EXPECTED_NAMES) console.log(`  ${name}: ${foundNames.has(name) ? 'YES' : 'MISSING'}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
