// ENT and SMB both now show 729 (identical to each other), Filters' Queue:
// Migration shows 680 -- after removing the 'passed' exclusion from
// deptMatchSql/rosterMatchSql. Something is now over-matching for Migration
// specifically (ENT/SMB share the same department, unlike Dev/eng which
// fixed cleanly). Pulls the full ticket-key list from both the live MBR
// team=ent endpoint and Filters' Queue: Migration, diffs them, and inspects
// the mismatched tickets directly (current_department, assignee, and their
// user_worked_on_tickets rows) to find the exact mechanism. Read-only.
//
// Usage: node check-migration-ent-gap-detail.mjs
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
  const payload = { sub: admin.id, ip: '', ua: 'migration-ent-gap-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'migration-ent-gap-check', new Date(Date.now() + 3600 * 1000)]
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
  console.log(`Filters Queue: Migration -- fetched ${filtersKeys.size} ticket keys (reported total: ${filtersResult.total})`);

  const entResult = await get(`/reports/mbr-team?team=ent&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`);
  const entKeys = new Set((entResult.tickets || []).map((t) => t.key));
  console.log(`MBR ENT -- fetched ${entKeys.size} ticket keys (reported total: ${entResult.summary?.total}, totalMatched: ${entResult.totalMatched})`);

  const smbResult = await get(`/reports/mbr-team?team=smb&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`);
  const smbKeys = new Set((smbResult.tickets || []).map((t) => t.key));
  console.log(`MBR SMB -- fetched ${smbKeys.size} ticket keys (reported total: ${smbResult.summary?.total}, totalMatched: ${smbResult.totalMatched})`);

  const entOnly = [...entKeys].filter((k) => !filtersKeys.has(k));
  const bothEntSmb = [...entKeys].filter((k) => smbKeys.has(k));
  console.log(`\nIn ENT but NOT in Filters: ${entOnly.length}`);
  console.log(`In BOTH ENT and SMB (overlap): ${bothEntSmb.length}`);
  console.log(`In Filters but NOT in ENT: ${[...filtersKeys].filter((k) => !entKeys.has(k)).length}`);

  if (entOnly.length) {
    const sample = entOnly.slice(0, 15);
    const { rows: issueRows } = await pool.query(`
      SELECT id, COALESCE(cf_key, key) AS key, current_department, original_dept, "createdAt", "updatedAt"
      FROM issues WHERE COALESCE(cf_key, key) = ANY($1::text[])
    `, [sample]);
    console.log(`\n=== Sample: in ENT but not Filters (${sample.length} of ${entOnly.length}) ===`);
    for (const r of issueRows) {
      console.log(`  ${r.key}: dept=${r.current_department} original_dept=${r.original_dept} created=${r.createdAt?.toISOString?.().slice(0,10)} updated=${r.updatedAt?.toISOString?.().slice(0,10)}`);
    }
    const ids = issueRows.map((r) => r.id);
    const { rows: workedRows } = await pool.query(`
      SELECT w.issue_id, w.dept, w.reason, wu.email AS worker_email, w.worked_at
      FROM user_worked_on_tickets w LEFT JOIN users wu ON wu.id = w.user_id
      WHERE w.issue_id = ANY($1::text[]) ORDER BY w.issue_id, w.worked_at ASC
    `, [ids]);
    const idToKey = Object.fromEntries(issueRows.map((r) => [r.id, r.key]));
    console.log(`\n=== Their user_worked_on_tickets rows ===`);
    let lastId = null;
    for (const r of workedRows) {
      if (r.issue_id !== lastId) { console.log(`\n${idToKey[r.issue_id]}:`); lastId = r.issue_id; }
      console.log(`  dept=${r.dept} reason=${r.reason} worker=${r.worker_email || 'null'}`);
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
