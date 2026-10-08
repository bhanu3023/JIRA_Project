// Per report that a selected date range "sometimes" includes tickets
// outside it (past tickets leaking in) -- checks the Filters page's actual
// live results for several date-range scenarios and verifies EVERY
// returned ticket's own createdAt/updatedAt genuinely falls inside the
// selected window. No reproduction case was given, so this sweeps several
// realistic combinations (Queue-scoped and not, Created-only/Updated-only/
// both, with and without an Assignee) across a recent month. Read-only.
//
// Usage: node check-date-range-leakage.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const BASE = `http://localhost:${PORT}/api`;
const SPACE_KEY = 'TESTIN';
const DATE_FROM = '2026-09-01';
const DATE_TO = '2026-09-30';

async function main() {
  const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const admin = adminRows[0];
  const payload = { sub: admin.id, ip: '', ua: 'date-range-leakage-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'date-range-leakage-check', new Date(Date.now() + 3600 * 1000)]
  );
  const headers = { Authorization: `Bearer ${token}` };
  async function get(path) {
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }

  const between = `between:${DATE_FROM}:${DATE_TO}`;
  // IST-anchored boundaries, same as parseDateRange's own "between:" logic,
  // to judge "is this timestamp actually in range" the same way the app does.
  const fromMs = new Date(`${DATE_FROM}T00:00:00+05:30`).getTime();
  const toMs = new Date(`${DATE_TO}T23:59:59.999+05:30`).getTime();
  const inRange = (iso) => {
    const t = new Date(iso).getTime();
    return t >= fromMs && t <= toMs;
  };

  const scenarios = [
    { label: 'Queue: Dev, Created only', params: { spaceKey: SPACE_KEY, dept: 'Dev', queueMembersOnly: 'true', createdRange: between } },
    { label: 'Queue: Dev, Updated only', params: { spaceKey: SPACE_KEY, dept: 'Dev', queueMembersOnly: 'true', updatedRange: between } },
    { label: 'Queue: Dev, Created + Updated (union)', params: { spaceKey: SPACE_KEY, dept: 'Dev', queueMembersOnly: 'true', createdRange: between, updatedRange: between } },
    { label: 'Queue: Migration, Created + Updated (union)', params: { spaceKey: SPACE_KEY, dept: 'Migration', queueMembersOnly: 'true', createdRange: between, updatedRange: between } },
    { label: 'No Queue (all spaces), Created only', params: { spaceKeys: SPACE_KEY, createdRange: between } },
    { label: 'No Queue (all spaces), Created + Updated (intersection)', params: { spaceKeys: SPACE_KEY, createdRange: between, updatedRange: between } },
    { label: 'Queue: Dev, Resolved date only', params: { spaceKey: SPACE_KEY, dept: 'Dev', queueMembersOnly: 'true', resolvedRange: between } },
    { label: 'Queue: Dev, Due Date only', params: { spaceKey: SPACE_KEY, dept: 'Dev', queueMembersOnly: 'true', dueDateRange: between } },
  ];

  let totalBad = 0;
  for (const sc of scenarios) {
    const qs = new URLSearchParams({ ...sc.params, page: '1', limit: '2000' });
    let data;
    try { data = await get(`/issues?${qs.toString()}`); } catch (e) { console.log(`${sc.label}: ERROR -- ${e.message}`); continue; }
    const issues = data.issues || [];
    const field = sc.params.resolvedRange ? 'resolvedAt' : sc.params.dueDateRange ? 'dueDate' : null;
    const bad = issues.filter((i) => {
      if (field) return i[field] ? !inRange(i[field]) : true; // must have the field AND be in range
      const createdOk = sc.params.createdRange ? inRange(i.createdAt) : false;
      const updatedOk = sc.params.updatedRange ? inRange(i.updatedAt) : false;
      if (sc.params.createdRange && sc.params.updatedRange) {
        // Queue-scoped = union (either ok); non-queue-scoped (no `dept`) = intersection (both ok)
        return sc.params.dept ? !(createdOk || updatedOk) : !(createdOk && updatedOk);
      }
      if (sc.params.createdRange) return !createdOk;
      if (sc.params.updatedRange) return !updatedOk;
      return false;
    });
    console.log(`${sc.label}: total=${data.total}, fetched=${issues.length}, OUT-OF-RANGE=${bad.length}`);
    if (bad.length) {
      totalBad += bad.length;
      console.log('  sample out-of-range:', bad.slice(0, 5).map((i) => `${i.cfKey ?? i.key} (created=${i.createdAt}, updated=${i.updatedAt}${field ? `, ${field}=${i[field]}` : ''})`));
    }
  }

  console.log(`\n${totalBad} total out-of-range ticket(s) found across ${scenarios.length} scenarios.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
