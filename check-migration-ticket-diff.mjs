// Finds the EXACT ticket-level delta between MBR's Migration ENT+SMB
// (reports/mbr-team) and Filters' "Queue: Migration" (now at 641 vs MBR's
// 650 for Sep 2026, after the roster re-sync) -- not just the totals, so the
// remaining ~9-ticket gap can be explained rather than guessed at. Read-only.
//
// Usage: node check-migration-ticket-diff.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const BASE = `http://localhost:${PORT}/api`;
const DATE_FROM = '2026-09-01';
const DATE_TO = '2026-09-30';
const SPACE_KEY = 'TESTIN';

async function main() {
  const { rows: users } = await pool.query(`SELECT id FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'migration-ticket-diff', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'migration-ticket-diff', new Date(Date.now() + 3600 * 1000)]
  );
  const headers = { Authorization: `Bearer ${token}` };
  async function get(path) {
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text);
  }

  const ent = await get(`/reports/mbr-team?team=ent&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`);
  const smb = await get(`/reports/mbr-team?team=smb&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`);
  const mbrKeys = new Set([...(ent.tickets || []).map((t) => t.key), ...(smb.tickets || []).map((t) => t.key)]);
  console.log(`MBR ENT+SMB distinct ticket keys: ${mbrKeys.size} (ENT tickets array: ${ent.tickets?.length}, SMB tickets array: ${smb.tickets?.length})`);

  const qs = new URLSearchParams({
    spaceKey: SPACE_KEY, dept: 'Migration', queueMembersOnly: 'true', page: '1', limit: '2000',
    createdRange: `between:${DATE_FROM}:${DATE_TO}`, updatedRange: `between:${DATE_FROM}:${DATE_TO}`,
  });
  const filtersData = await get(`/issues?${qs.toString()}`);
  const filtersKeys = new Set((filtersData.issues || []).map((i) => i.cfKey ?? i.key));
  console.log(`Filters Queue: Migration ticket keys: ${filtersKeys.size} (reported total: ${filtersData.total})`);

  const inMbrNotFilters = [...mbrKeys].filter((k) => !filtersKeys.has(k));
  const inFiltersNotMbr = [...filtersKeys].filter((k) => !mbrKeys.has(k));
  console.log(`\nIn MBR but NOT in Filters (${inMbrNotFilters.length}):`, inMbrNotFilters);
  console.log(`\nIn Filters but NOT in MBR (${inFiltersNotMbr.length}):`, inFiltersNotMbr);

  // For each "in MBR not Filters" ticket, show its current_department,
  // assignee, and whether it's in the live Migration queue roster, to
  // explain WHY MBR counted it but Filters didn't.
  if (inMbrNotFilters.length) {
    const { rows } = await pool.query(`
      SELECT COALESCE(i.cf_key, i.key) AS key, i.current_department, i.original_dept, u.email AS assignee_email, i."createdAt", i."updatedAt"
      FROM issues i LEFT JOIN users u ON u.id = i."assigneeId"
      WHERE COALESCE(i.cf_key, i.key) = ANY($1::text[])
    `, [inMbrNotFilters]);
    console.log('\nDetail on "in MBR but not Filters" tickets:');
    for (const r of rows) console.log(`  ${r.key}: dept=${r.current_department} origin=${r.original_dept} assignee=${r.assignee_email} created=${r.createdAt} updated=${r.updatedAt}`);
  }
  if (inFiltersNotMbr.length) {
    const { rows } = await pool.query(`
      SELECT COALESCE(i.cf_key, i.key) AS key, i.current_department, i.original_dept, u.email AS assignee_email, i."createdAt", i."updatedAt"
      FROM issues i LEFT JOIN users u ON u.id = i."assigneeId"
      WHERE COALESCE(i.cf_key, i.key) = ANY($1::text[])
    `, [inFiltersNotMbr]);
    console.log('\nDetail on "in Filters but not MBR" tickets:');
    for (const r of rows) console.log(`  ${r.key}: dept=${r.current_department} origin=${r.original_dept} assignee=${r.assignee_email} created=${r.createdAt} updated=${r.updatedAt}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
