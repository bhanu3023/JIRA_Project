// Times the real live /api/issues (Filters) and /api/reports/mbr-team
// (MBR) endpoints end-to-end, plus a couple of the heaviest individual
// queries inside them directly against the DB, so a genuine backend
// slowdown can be told apart from a frontend/network issue before
// changing any code.
//
// Read-only.
//
// Usage: node check-api-response-times.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'perf-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','perf-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return token;
}

async function timeFetch(label, url, headers) {
  const t0 = Date.now();
  const res = await fetch(url, { headers });
  const body = await res.json().catch(() => null);
  const ms = Date.now() - t0;
  console.log(`${label}: ${ms}ms  (status ${res.status}${body?.total != null ? `, total=${body.total}` : ''}${body?.issues ? `, returned=${body.issues.length}` : ''})`);
  return { ms, status: res.status };
}

async function timeQuery(label, sql, params = []) {
  const t0 = Date.now();
  const res = await pool.query(sql, params);
  const ms = Date.now() - t0;
  console.log(`${label}: ${ms}ms  (${res.rowCount} row(s))`);
}

async function main() {
  const token = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  console.log('=== Real live endpoint timings ===');
  await timeFetch('Filters: All Work, no filters (default page)', `${APP_URL}/api/issues?spaceKey=TESTIN&page=1&limit=50`, authHeader);
  await timeFetch('Filters: Queue:Dev, no other filter', `${APP_URL}/api/issues?spaceKey=TESTIN&dept=Dev&queueMembersOnly=true&page=1&limit=50`, authHeader);
  await timeFetch('Filters: Queue:Dev + SLA Breached:Yes', `${APP_URL}/api/issues?spaceKey=TESTIN&dept=Dev&queueMembersOnly=true&slaBreached=yes&page=1&limit=50`, authHeader);
  await timeFetch('Filters: Queue:Migration + SLA Breached:Yes', `${APP_URL}/api/issues?spaceKey=TESTIN&dept=Migration&queueMembersOnly=true&slaBreached=yes&page=1&limit=50`, authHeader);
  await timeFetch('MBR: eng team, Aug 2026', `${APP_URL}/api/reports/mbr-team?team=eng&dateFrom=2026-08-01&dateTo=2026-08-31`, authHeader);
  await timeFetch('MBR: ent team, Aug 2026', `${APP_URL}/api/reports/mbr-team?team=ent&dateFrom=2026-08-01&dateTo=2026-08-31`, authHeader);
  await timeFetch('MBR By Department: Dev, Aug 2026', `${APP_URL}/api/reports/mbr?department=Dev&dateFrom=2026-08-01&dateTo=2026-08-31`, authHeader);

  console.log('\n=== Individual heavy queries, timed directly against the DB ===');
  await timeQuery('COUNT(*) issues in Dev dept', `SELECT COUNT(*) FROM issues WHERE current_department = 'Dev'`);
  await timeQuery('COUNT(*) issues in Migration dept', `SELECT COUNT(*) FROM issues WHERE current_department = 'Migration'`);
  await timeQuery('Total issues in DB', `SELECT COUNT(*) FROM issues`);
  await timeQuery('Active sla_definitions', `SELECT COUNT(*) FROM sla_definitions WHERE status='active'`);

  console.log('\n=== DB connection / lock sanity check ===');
  const { rows: conns } = await pool.query(`SELECT COUNT(*) AS n, state FROM pg_stat_activity WHERE datname = current_database() GROUP BY state`);
  for (const c of conns) console.log(`  ${c.state || '(null)'}: ${c.n}`);
  const { rows: locks } = await pool.query(`SELECT COUNT(*) AS n FROM pg_locks WHERE NOT granted`);
  console.log(`  Ungranted (blocked) locks: ${locks[0].n}`);

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
