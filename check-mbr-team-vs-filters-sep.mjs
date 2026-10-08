// Verifies the rosterMatchSql fix actually closes the gap reported for real:
// MBR's Customer Engineering (team=eng) tab vs Filters' Queue: Dev, and
// MBR's combined ENT+SMB tabs vs Filters' Queue: Migration, for Sep 2026.
// Hits both live endpoints directly (same ones the UI calls) rather than
// querying the DB by hand, so this reflects exactly what a user sees.
// Read-only.
//
// Usage: node check-mbr-team-vs-filters-sep.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const BASE = `http://localhost:${PORT}/api`;
const DATE_FROM = '2026-09-01';
const DATE_TO = '2026-09-30';

async function main() {
  const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const admin = adminRows[0];
  const payload = { sub: admin.id, ip: '', ua: 'mbr-team-vs-filters-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'mbr-team-vs-filters-check', new Date(Date.now() + 3600 * 1000)]
  );
  const headers = { Authorization: `Bearer ${token}` };
  async function get(path) {
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text);
  }

  // MBR team tabs -- Total for the date range (ticketFilter left blank = Total view)
  const engMbr = await get(`/reports/mbr-team?team=eng&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`);
  const entMbr = await get(`/reports/mbr-team?team=ent&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`);
  const smbMbr = await get(`/reports/mbr-team?team=smb&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`);

  // Filters' dept-scoped count -- same "touched in range" semantics (createdAt
  // OR updatedAt), using the between: date-range format Filters itself sends.
  // Real param names confirmed from jira-pg-api.ts: `dept` (not `department`)
  // triggers the dept-scoped branch, and `queueMembersOnly=true` is what
  // actually engages memberClause (the Queue: X semantics) -- the first
  // version of this script used `department=` (silently ignored, a no-op)
  // and both totals came back identical as a result.
  const dateParam = `between:${DATE_FROM}:${DATE_TO}`;
  const devFilters = await get(`/issues?spaceKey=TESTIN&dept=Dev&queueMembersOnly=true&createdRange=${encodeURIComponent(dateParam)}&updatedRange=${encodeURIComponent(dateParam)}&limit=1`);
  const migrationFilters = await get(`/issues?spaceKey=TESTIN&dept=Migration&queueMembersOnly=true&createdRange=${encodeURIComponent(dateParam)}&updatedRange=${encodeURIComponent(dateParam)}&limit=1`);

  console.log(`=== Sep 2026 (${DATE_FROM} to ${DATE_TO}) ===\n`);
  console.log('MBR team=eng summary:', JSON.stringify(engMbr.summary));
  console.log('Filters Queue: Dev total:', devFilters.total ?? JSON.stringify(devFilters).slice(0, 200));
  console.log('');
  console.log('MBR team=ent summary:', JSON.stringify(entMbr.summary));
  console.log('MBR team=smb summary:', JSON.stringify(smbMbr.summary));
  console.log('Filters Queue: Migration total:', migrationFilters.total ?? JSON.stringify(migrationFilters).slice(0, 200));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
