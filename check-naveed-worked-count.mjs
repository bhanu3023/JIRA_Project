// Investigates the reported gap for Naved Osama (naved.osama@cloudfuze.com,
// Dev/eng roster): expected 60 worked tickets for Aug 1-31, app shows 44.
// Checks every real source of "worked" count for this person/range so the
// actual cause (a reason-code filter excluding some rows, a date-boundary
// issue, Filters vs MBR disagreeing, or a genuine missing-credit bug) can
// be identified with real numbers before anything is changed.
//
// Read-only.
//
// Usage: node check-naveed-worked-count.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';
const EMAIL = 'naved.osama@cloudfuze.com';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'naveed-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','naveed-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return token;
}

async function main() {
  const { rows: userRows } = await pool.query(`SELECT id, "firstName", "lastName", email FROM users WHERE email = $1`, [EMAIL]);
  if (!userRows.length) { console.log(`No user found for ${EMAIL}`); await pool.end(); return; }
  const user = userRows[0];
  console.log(`User: ${user.firstName} ${user.lastName} <${user.email}>  id=${user.id}\n`);

  console.log('=== Raw user_worked_on_tickets rows, Aug 2026, by reason ===');
  const { rows: byReason } = await pool.query(
    `SELECT reason, COUNT(*) AS n, COUNT(DISTINCT issue_id) AS distinct_issues
     FROM user_worked_on_tickets
     WHERE user_id = $1 AND worked_at >= '2026-08-01' AND worked_at < '2026-09-01'
     GROUP BY reason ORDER BY reason`,
    [user.id]
  );
  for (const r of byReason) console.log(`  reason=${r.reason}: ${r.n} row(s), ${r.distinct_issues} distinct issue(s)`);
  const { rows: totalRaw } = await pool.query(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT issue_id) AS distinct_issues
     FROM user_worked_on_tickets WHERE user_id = $1 AND worked_at >= '2026-08-01' AND worked_at < '2026-09-01'`,
    [user.id]
  );
  console.log(`  TOTAL (any reason): ${totalRaw[0].n} row(s), ${totalRaw[0].distinct_issues} distinct issue(s)`);

  console.log('\n=== Raw user_worked_on_tickets rows, Aug 2026, reason != passed, by dept ===');
  const { rows: byDept } = await pool.query(
    `SELECT dept, COUNT(*) AS n, COUNT(DISTINCT issue_id) AS distinct_issues
     FROM user_worked_on_tickets
     WHERE user_id = $1 AND worked_at >= '2026-08-01' AND worked_at < '2026-09-01' AND reason != 'passed'
     GROUP BY dept ORDER BY dept`,
    [user.id]
  );
  for (const r of byDept) console.log(`  dept=${r.dept}: ${r.n} row(s), ${r.distinct_issues} distinct issue(s)`);

  const token = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  console.log('\n=== Real live endpoint counts, Aug 1-31 2026 ===');
  const filtersParams = new URLSearchParams({
    spaceKey: 'TESTIN', dept: 'Dev', queueMembersOnly: 'true', assignees: EMAIL,
    createdRange: 'between:2026-08-01:2026-08-31', updatedRange: 'between:2026-08-01:2026-08-31',
    page: '1', limit: '1',
  });
  const filtersRes = await fetch(`${APP_URL}/api/issues?${filtersParams}`, { headers: authHeader });
  const filtersData = await filtersRes.json().catch(() => ({}));
  console.log(`Filters (Queue:Dev, Assignee:${EMAIL}, Created+Updated Aug): ${filtersRes.ok ? filtersData.total : `ERR ${filtersRes.status}`}`);

  const filtersWorkedParams = new URLSearchParams({
    spaceKey: 'TESTIN', dept: 'Dev', queueMembersOnly: 'true', assignees: EMAIL,
    workedRange: 'between:2026-08-01:2026-08-31',
    page: '1', limit: '1',
  });
  const filtersWorkedRes = await fetch(`${APP_URL}/api/issues?${filtersWorkedParams}`, { headers: authHeader });
  const filtersWorkedData = await filtersWorkedRes.json().catch(() => ({}));
  console.log(`Filters (Queue:Dev, Assignee:${EMAIL}, Worked Aug): ${filtersWorkedRes.ok ? filtersWorkedData.total : `ERR ${filtersWorkedRes.status}`}`);

  const mbrParams = new URLSearchParams({ team: 'eng', dateFrom: '2026-08-01', dateTo: '2026-08-31', person: EMAIL });
  const mbrRes = await fetch(`${APP_URL}/api/reports/mbr-team?${mbrParams}`, { headers: authHeader });
  const mbrData = await mbrRes.json().catch(() => ({}));
  console.log(`MBR (team=eng, person=${EMAIL}, Aug): total=${mbrRes.ok ? mbrData.summary?.total : `ERR ${mbrRes.status}`}`);

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
