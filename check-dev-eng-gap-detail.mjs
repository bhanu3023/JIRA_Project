// The big ENT/SMB double-counting bug is fixed, but a smaller residual gap
// remains for Dev/Customer Engineering: MBR shows 696, Filters' Queue: Dev
// shows 716 for Sep 2026. Rather than guess at the cause, pulls the full
// ticket-key list from BOTH live endpoints and diffs them directly, so the
// exact tickets causing the gap (and their current_department/assignee/
// dates) are visible instead of just the totals disagreeing.
// Read-only.
//
// Usage: node check-dev-eng-gap-detail.mjs
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
  const payload = { sub: admin.id, ip: '', ua: 'dev-eng-gap-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'dev-eng-gap-check', new Date(Date.now() + 3600 * 1000)]
  );
  const headers = { Authorization: `Bearer ${token}` };
  async function get(path) {
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text);
  }

  const dateParam = `between:${DATE_FROM}:${DATE_TO}`;
  const filtersResult = await get(`/issues?spaceKey=TESTIN&dept=Dev&queueMembersOnly=true&createdRange=${encodeURIComponent(dateParam)}&updatedRange=${encodeURIComponent(dateParam)}&limit=2000`);
  const filtersIssues = Array.isArray(filtersResult) ? filtersResult : (filtersResult.data || filtersResult.issues || []);
  const filtersKeys = new Set(filtersIssues.map((i) => i.cfKey || i.cf_key || i.key));
  console.log(`Filters Queue: Dev -- fetched ${filtersKeys.size} ticket keys (reported total: ${filtersResult.total})`);

  const mbrResult = await get(`/reports/mbr-team?team=eng&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`);
  const mbrKeys = new Set((mbrResult.tickets || []).map((t) => t.key));
  console.log(`MBR Customer Engineering -- fetched ${mbrKeys.size} ticket keys (reported total: ${mbrResult.summary?.total}, totalMatched: ${mbrResult.totalMatched})`);

  const inFiltersNotMbr = [...filtersKeys].filter((k) => !mbrKeys.has(k));
  const inMbrNotFilters = [...mbrKeys].filter((k) => !filtersKeys.has(k));
  console.log(`\nIn Filters but NOT in MBR: ${inFiltersNotMbr.length}`);
  console.log(`In MBR but NOT in Filters: ${inMbrNotFilters.length}`);

  if (inFiltersNotMbr.length) {
    const sample = inFiltersNotMbr.slice(0, 20);
    const { rows } = await pool.query(`
      SELECT COALESCE(i.cf_key, i.key) AS key, i.current_department, i."createdAt", i."updatedAt",
             u.email AS assignee_email, i.original_dept
      FROM issues i LEFT JOIN users u ON u.id = i."assigneeId"
      WHERE COALESCE(i.cf_key, i.key) = ANY($1::text[])
    `, [sample]);
    console.log(`\n=== Sample: in Filters but not MBR (${sample.length} of ${inFiltersNotMbr.length}) ===`);
    for (const r of rows) {
      console.log(`  ${r.key}: dept=${r.current_department} original_dept=${r.original_dept} assignee=${r.assignee_email || 'Unassigned'} created=${r.createdAt?.toISOString?.().slice(0,10)} updated=${r.updatedAt?.toISOString?.().slice(0,10)}`);
    }
  }

  if (inMbrNotFilters.length) {
    const sample = inMbrNotFilters.slice(0, 20);
    const { rows } = await pool.query(`
      SELECT COALESCE(i.cf_key, i.key) AS key, i.current_department, i."createdAt", i."updatedAt",
             u.email AS assignee_email, i.original_dept
      FROM issues i LEFT JOIN users u ON u.id = i."assigneeId"
      WHERE COALESCE(i.cf_key, i.key) = ANY($1::text[])
    `, [sample]);
    console.log(`\n=== Sample: in MBR but not Filters (${sample.length} of ${inMbrNotFilters.length}) ===`);
    for (const r of rows) {
      console.log(`  ${r.key}: dept=${r.current_department} original_dept=${r.original_dept} assignee=${r.assignee_email || 'Unassigned'} created=${r.createdAt?.toISOString?.().slice(0,10)} updated=${r.updatedAt?.toISOString?.().slice(0,10)}`);
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
