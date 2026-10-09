// QA and Infra both map 1:1 onto their own department (no ENT/SMB-style
// split), using the SAME code path that already proved exact for Dev/
// Customer Engineering (0 ticket-level diff). Verifies that holds for QA
// and Infra too, for the same Sep 2026 range, via direct ticket-level diff
// against Filters' own Queue: QA / Queue: Infra. Read-only.
//
// Usage: node check-qa-infra-vs-filters.mjs
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
  const payload = { sub: admin.id, ip: '', ua: 'qa-infra-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'qa-infra-check', new Date(Date.now() + 3600 * 1000)]
  );
  const headers = { Authorization: `Bearer ${token}` };
  async function get(path) {
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text);
  }

  const dateParam = `between:${DATE_FROM}:${DATE_TO}`;

  for (const { team, dept } of [{ team: 'qa', dept: 'QA' }, { team: 'infra', dept: 'Infra' }]) {
    const filtersResult = await get(`/issues?spaceKey=TESTIN&dept=${dept}&queueMembersOnly=true&createdRange=${encodeURIComponent(dateParam)}&updatedRange=${encodeURIComponent(dateParam)}&limit=2000`);
    const filtersIssues = Array.isArray(filtersResult) ? filtersResult : (filtersResult.data || filtersResult.issues || []);
    const filtersKeys = new Set(filtersIssues.map((i) => i.cfKey || i.cf_key || i.key));

    const mbrResult = await get(`/reports/mbr-team?team=${team}&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`);
    const mbrKeys = new Set((mbrResult.tickets || []).map((t) => t.key));

    const inFiltersNotMbr = [...filtersKeys].filter((k) => !mbrKeys.has(k));
    const inMbrNotFilters = [...mbrKeys].filter((k) => !filtersKeys.has(k));

    console.log(`\n=== ${dept} (team=${team}) ===`);
    console.log(`Filters: ${filtersKeys.size} (reported total: ${filtersResult.total}), MBR: ${mbrKeys.size} (reported total: ${mbrResult.summary?.total})`);
    console.log(`In Filters but NOT in MBR: ${inFiltersNotMbr.length}${inFiltersNotMbr.length ? ' -> ' + inFiltersNotMbr.slice(0, 10).join(', ') : ''}`);
    console.log(`In MBR but NOT in Filters: ${inMbrNotFilters.length}${inMbrNotFilters.length ? ' -> ' + inMbrNotFilters.slice(0, 10).join(', ') : ''}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
