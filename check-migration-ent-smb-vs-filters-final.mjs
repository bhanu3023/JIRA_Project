// Diffs ENT∪SMB's actual ticket set against Filters' Queue: Migration for
// ANY date range, to confirm the exact-match fix holds for new tickets, not
// just the Sep 2026 data it was originally built against. Read-only.
//
// Usage: node check-migration-ent-smb-vs-filters-final.mjs [YYYY-MM-DD] [YYYY-MM-DD]
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const BASE = `http://localhost:${PORT}/api`;
const DATE_FROM = process.argv[2] || '2026-09-01';
const DATE_TO = process.argv[3] || '2026-09-30';

async function main() {
  const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const admin = adminRows[0];
  const payload = { sub: admin.id, ip: '', ua: 'migration-final-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'migration-final-check', new Date(Date.now() + 3600 * 1000)]
  );
  const headers = { Authorization: `Bearer ${token}` };
  async function get(path) {
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text);
  }

  const dateParam = `between:${DATE_FROM}:${DATE_TO}`;
  const filtersResult = await get(`/issues?spaceKey=TESTIN&dept=Migration&queueMembersOnly=true&createdRange=${encodeURIComponent(dateParam)}&updatedRange=${encodeURIComponent(dateParam)}&limit=2000`);
  const filtersIssues = Array.isArray(filtersResult) ? filtersResult : (filtersResult.data || filtersResult.issues || []);
  const filtersKeys = new Set(filtersIssues.map((i) => i.cfKey || i.cf_key || i.key));

  const entResult = await get(`/reports/mbr-team?team=ent&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`);
  const entKeys = new Set((entResult.tickets || []).map((t) => t.key));
  const smbResult = await get(`/reports/mbr-team?team=smb&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`);
  const smbKeys = new Set((smbResult.tickets || []).map((t) => t.key));

  const mbrUnion = new Set([...entKeys, ...smbKeys]);
  const overlap = [...entKeys].filter((k) => smbKeys.has(k));
  console.log(`Filters: ${filtersKeys.size}, ENT: ${entKeys.size}, SMB: ${smbKeys.size}, ENT+SMB sum: ${entKeys.size + smbKeys.size}, ENT∩SMB overlap: ${overlap.length}, ENT∪SMB union: ${mbrUnion.size}`);
  if (overlap.length) console.log(`Overlap tickets (should be 0 now): ${overlap.join(', ')}`);

  const inMbrNotFilters = [...mbrUnion].filter((k) => !filtersKeys.has(k));
  const inFiltersNotMbr = [...filtersKeys].filter((k) => !mbrUnion.has(k));
  console.log(`\nIn ENT∪SMB but NOT in Filters: ${inMbrNotFilters.length}`);
  console.log(`In Filters but NOT in ENT∪SMB: ${inFiltersNotMbr.length}`);

  const allMismatched = [...inMbrNotFilters, ...inFiltersNotMbr];
  if (allMismatched.length) {
    const { rows } = await pool.query(`
      SELECT COALESCE(i.cf_key, i.key) AS key, i.current_department, i.original_dept, i."projectPool",
             u.email AS assignee_email, i."createdAt", i."updatedAt"
      FROM issues i LEFT JOIN users u ON u.id = i."assigneeId"
      WHERE COALESCE(i.cf_key, i.key) = ANY($1::text[])
    `, [allMismatched]);
    console.log(`\n=== Mismatched tickets detail ===`);
    for (const r of rows) {
      const where = inMbrNotFilters.includes(r.key) ? 'MBR only' : 'Filters only';
      console.log(`  ${r.key} [${where}]: dept=${r.current_department} original_dept=${r.original_dept} projectPool=${r.projectPool} assignee=${r.assignee_email || 'Unassigned'} created=${r.createdAt?.toISOString?.().slice(0,10)} updated=${r.updatedAt?.toISOString?.().slice(0,10)}`);
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
