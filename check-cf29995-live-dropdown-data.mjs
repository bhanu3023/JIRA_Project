// The dropdown still shows no "Resolved" option for CF-29995 even after
// fixing its dept_statuses snapshot in the DB. Calls the exact two real
// live endpoints the frontend uses to build that dropdown --
// /api/issues/CF-29995 (for dept_statuses/current_department/status) and
// /api/department-queue?dept=Pre-sales&spaceKey=TESTIN (for
// queueStatuses/queueTransitions) -- to see precisely what data the
// browser is actually working with, rather than assuming the DB fix
// alone was enough.
//
// Usage: node check-cf29995-live-dropdown-data.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'cf29995-dropdown-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','cf29995-dropdown-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return token;
}

async function main() {
  const token = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const issueRes = await fetch(`${APP_URL}/api/issues/CF-29995`, { headers: authHeader });
  const issueData = await issueRes.json();
  console.log(`=== /api/issues/CF-29995 (live) ===`);
  console.log(`current_department: ${issueData.current_department}`);
  console.log(`status: ${JSON.stringify(issueData.status)}`);
  console.log(`dept_statuses: ${JSON.stringify(issueData.dept_statuses)}`);

  const dept = issueData.current_department;
  const queueRes = await fetch(`${APP_URL}/api/department-queue?dept=${encodeURIComponent(dept)}&spaceKey=TESTIN`, { headers: authHeader });
  const queueData = await queueRes.json();
  console.log(`\n=== /api/department-queue?dept=${dept}&spaceKey=TESTIN (live) ===`);
  console.log(`spaceKey: ${queueData.spaceKey}`);
  console.log(`queue.name: ${queueData.queue?.name}`);
  console.log(`queue.queueStatuses: ${JSON.stringify(queueData.queue?.queueStatuses)}`);
  console.log(`queue.queueTransitions: ${JSON.stringify(queueData.queue?.queueTransitions)}`);

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
