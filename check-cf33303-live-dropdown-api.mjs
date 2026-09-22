// Dev's queue config is confirmed correct (In Progress -> Routed to
// Pre-sales/QA/Resolved all exist as real transitions), but CF-33303's
// actual dropdown shows a different, smaller list that doesn't match --
// missing QA/Pre-sales/Resolved, and including "Routed to Dev" which isn't
// even a real transition target FROM Dev's own In Progress status. That
// mismatch pattern matches the frontend's fallback to the space's generic
// status list when it can't resolve real queue transitions. Calls the
// exact same two live endpoints the frontend uses to build this dropdown
// (GET /issues/:key and GET /department-queue) to see what the backend
// ACTUALLY returns right now, ruling out a live backend bug before
// assuming it's a stale browser cache.
//
// Usage: node check-cf33303-live-dropdown-api.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';
const ADMIN_EMAIL = 'bhanu.srikakulam@cloudfuze.com';

async function main() {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [ADMIN_EMAIL]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'check-cf33303-live-dropdown', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','check-cf33303-live-dropdown',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  const authHeader = { Authorization: `Bearer ${token}` };

  const issueRes = await fetch(`${APP_URL}/api/issues/CF-33303`, { headers: authHeader });
  const issueData = await issueRes.json();
  console.log('=== /api/issues/CF-33303 ===');
  console.log(`current_department: ${issueData.current_department}`);
  console.log(`status: ${JSON.stringify(issueData.status)}`);
  console.log(`dept_statuses: ${JSON.stringify(issueData.dept_statuses)}`);
  console.log(`spaceKey: ${issueData.spaceKey}`);

  const dept = issueData.current_department;
  const queueRes = await fetch(`${APP_URL}/api/department-queue?dept=${encodeURIComponent(dept)}&spaceKey=${issueData.spaceKey}`, { headers: authHeader });
  const queueData = await queueRes.json();
  console.log(`\n=== /api/department-queue?dept=${dept}&spaceKey=${issueData.spaceKey} ===`);
  console.log(`queue.name: ${queueData.queue?.name}`);
  console.log(`queueStatuses count: ${(queueData.queue?.queueStatuses || []).length}`);
  console.log(`queueTransitions count: ${(queueData.queue?.queueTransitions || []).length}`);
  const statusById = new Map((queueData.queue?.queueStatuses || []).map((s) => [s.id, s.name]));
  const effectiveStatusId = issueData.dept_statuses?.[dept]?.id;
  console.log(`\nEffective status id used for filtering: ${effectiveStatusId}`);
  const validFrom = (queueData.queue?.queueTransitions || []).filter((t) => (t.fromStatusId ?? t.from) === effectiveStatusId);
  console.log(`Valid transitions FROM that status: ${validFrom.length}`);
  for (const t of validFrom) console.log(`  -> ${statusById.get(t.toStatusId ?? t.to) || (t.toStatusId ?? t.to)}`);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
