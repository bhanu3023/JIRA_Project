// Compares the real live /issues (Filters, Queue:<dept>) count against the
// real live /reports/mbr (MBR By Department, department=<dept>) count for
// the same Created+Updated Aug 2026 range -- same real-session approach as
// check-ce-roster-filters-vs-mbr.mjs. Now takes the department as an
// argument so it works for Dev, Infra, QA, etc. without duplicating.
//
// Usage: node check-dev-dept-filters-vs-mbr.mjs [department]   (default: Dev)

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';
const DEPT = process.argv[2] || 'Dev';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'dev-dept-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','dev-dept-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return token;
}

async function main() {
  const token = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const filtersParams = new URLSearchParams({
    spaceKey: 'TESTIN', dept: DEPT, queueMembersOnly: 'true',
    createdRange: 'between:2026-08-01:2026-08-31', updatedRange: 'between:2026-08-01:2026-08-31',
    page: '1', limit: '1',
  });
  const filtersRes = await fetch(`${APP_URL}/api/issues?${filtersParams}`, { headers: authHeader });
  const filtersData = await filtersRes.json();
  console.log(`Filters (Queue:${DEPT}, Created+Updated Aug 2026): ${filtersRes.ok ? filtersData.total : `ERR ${filtersRes.status}`}`);

  const mbrParams = new URLSearchParams({ department: DEPT, dateFrom: '2026-08-01', dateTo: '2026-08-31' });
  const mbrRes = await fetch(`${APP_URL}/api/reports/mbr?${mbrParams}`, { headers: authHeader });
  const mbrData = await mbrRes.json();
  // The `departments` array is an open/unassigned/old30/overdue/slaBreached
  // BREAKDOWN, keyed by `dept` -- it has no per-department ticket total at
  // all. The real comparable total to Filters' own count is the endpoint's
  // top-level `totalMatched` (confirmed by reading the handler's own
  // `return json({ departments, people, tickets, totalMatched })` and the
  // ticketRows query's `COUNT(*) OVER() AS total_matched` it's built from).
  const deptRow = (mbrData.departments || []).find(d => (d.dept || '').toLowerCase() === DEPT.toLowerCase());
  console.log(`MBR By Department (department=${DEPT}, same range): total=${mbrRes.ok ? mbrData.totalMatched : `ERR ${mbrRes.status}`}  (breakdown: ${JSON.stringify(deptRow)})`);

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
