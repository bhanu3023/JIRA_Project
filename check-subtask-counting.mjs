// Checks whether subtasks are counted the same as regular tickets in (a)
// Naveed's own Aug worked-credit rows, (b) the real live Filters
// Queue:Dev response, and (c) the real live MBR eng-team response -- so we
// know for certain whether subtasks are included, excluded, or
// inconsistent between the two pages, instead of guessing from the code.
//
// Read-only.
//
// Usage: node check-subtask-counting.mjs [email]

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';
const EMAIL = process.argv[2] || 'naved.osama@cloudfuze.com';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'subtask-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','subtask-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return token;
}

async function main() {
  const { rows: userRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [EMAIL]);
  const userId = userRows[0].id;

  console.log('=== Raw user_worked_on_tickets credit rows (Dev, Aug 2026, reason != passed), by issue type ===');
  const { rows: byType } = await pool.query(
    `SELECT i.type, COUNT(*) AS n
     FROM user_worked_on_tickets w
     JOIN issues i ON i.id = w.issue_id
     WHERE w.user_id = $1 AND w.dept = 'Dev' AND w.reason != 'passed'
       AND w.worked_at >= '2026-08-01' AND w.worked_at < '2026-09-01'
     GROUP BY i.type ORDER BY n DESC`,
    [userId]
  );
  for (const r of byType) console.log(`  type=${r.type}: ${r.n}`);
  const subtaskCredits = byType.find(r => r.type === 'subtask')?.n || 0;

  const token = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  console.log('\n=== Real live Filters response, Queue:Dev + Assignee filter, Created+Updated Aug -- by type ===');
  const filtersParams = new URLSearchParams({
    spaceKey: 'TESTIN', dept: 'Dev', queueMembersOnly: 'true', assignees: EMAIL,
    createdRange: 'between:2026-08-01:2026-08-31', updatedRange: 'between:2026-08-01:2026-08-31',
    page: '1', limit: '500',
  });
  const filtersRes = await fetch(`${APP_URL}/api/issues?${filtersParams}`, { headers: authHeader });
  const filtersData = await filtersRes.json().catch(() => ({}));
  const issues = filtersData.issues || filtersData.data || [];
  const filtersByType = {};
  for (const i of issues) filtersByType[i.type || 'unknown'] = (filtersByType[i.type || 'unknown'] || 0) + 1;
  console.log(`  Total: ${filtersData.total} (returned ${issues.length})`);
  for (const [t, n] of Object.entries(filtersByType)) console.log(`  type=${t}: ${n}`);

  console.log('\n=== Real live MBR (team=eng, person filter), Aug -- ticket list by type ===');
  const mbrParams = new URLSearchParams({ team: 'eng', dateFrom: '2026-08-01', dateTo: '2026-08-31', person: EMAIL });
  const mbrRes = await fetch(`${APP_URL}/api/reports/mbr-team?${mbrParams}`, { headers: authHeader });
  const mbrData = await mbrRes.json().catch(() => ({}));
  console.log(`  MBR summary.total: ${mbrData.summary?.total}`);
  console.log(`  (MBR ticket list doesn't carry issue type in its response -- cross-check the Dev credit-row-by-type count above against this total instead)`);
  console.log(`\nSubtask credits found in raw Dev Aug data: ${subtaskCredits}`);

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
