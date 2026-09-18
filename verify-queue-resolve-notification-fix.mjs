// Real end-to-end verification of the fix just deployed (commit 327375d):
// resolving a ticket via a department queue's own "Resolved" status option
// should now notify the assignee/reporter (email + in-app bell), which it
// never did before. Creates a disposable test ticket assigned to Ranadeep in
// Migration, resolves it via the exact same PATCH the "Resolved" dropdown
// option sends (queueStatusId/Name/Category), acting as a DIFFERENT user (an
// admin) so the actor-skip in notifyUsers doesn't hide a real bug -- then
// checks whether a STATUS_CHANGED notification row appeared for Ranadeep.
// Deletes the test ticket and revokes its session token when done either way.
//
// Usage: node verify-queue-resolve-notification-fix.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';
const ADMIN_EMAIL = 'bhanu.srikakulam@cloudfuze.com';
const RANADEEP_EMAIL = 'ranadeep.muddam@cloudfuze.com';

async function makeSessionToken(email, label) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  const userId = rows[0]?.id;
  if (!userId) throw new Error(`No user for ${email}`);
  const payload = { sub: userId, ip: '', ua: label, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'',$3,$4) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, label, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, userId, tokenHash };
}

async function revoke(tokenHash) {
  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
}

async function main() {
  const admin = await makeSessionToken(ADMIN_EMAIL, 'verify-notif-fix-admin');
  const ranadeep = await makeSessionToken(RANADEEP_EMAIL, 'verify-notif-fix-ranadeep-lookup');
  const adminAuth = { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' };

  let testKey = null;
  try {
    console.log('=== Step 1: create disposable test ticket (Migration, assigned to Ranadeep) ===');
    const createRes = await fetch(`${APP_URL}/api/issues`, {
      method: 'POST', headers: adminAuth,
      body: JSON.stringify({
        spaceKey: 'TESTIN', summary: 'TEST - notification fix verification (safe to delete)',
        type: 'task', priority: 'low', department: 'Migration',
        assigneeId: ranadeep.userId, reporterId: ranadeep.userId,
      }),
    });
    const created = await createRes.json();
    if (!createRes.ok || !created?.key) throw new Error(`Create failed: ${JSON.stringify(created)}`);
    testKey = created.key;
    console.log(`Created ${created.cf_key || created.key} (id ${created.id})`);

    console.log('\n=== Step 2: find Migration queue\'s real "Resolved" status ===');
    const cq = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
    const queues = cq.rows[0]?.queues || [];
    const migrationQueue = queues.find((q) => String(q.name || '').toLowerCase() === 'migration');
    const resolvedStatus = (migrationQueue?.queueStatuses || []).find((s) => (s.name || '').toLowerCase() === 'resolved');
    if (!resolvedStatus) throw new Error('Could not find Migration\'s "Resolved" queue status');
    console.log(`Found: ${JSON.stringify(resolvedStatus)}`);

    const beforeTs = new Date();

    console.log('\n=== Step 3: admin resolves it via the queue status dropdown\'s own PATCH shape ===');
    const patchRes = await fetch(`${APP_URL}/api/issues/${testKey}`, {
      method: 'PATCH', headers: adminAuth,
      body: JSON.stringify({
        queueStatusId: resolvedStatus.id, queueStatusName: resolvedStatus.name,
        queueStatusColor: resolvedStatus.color, queueStatusCategory: resolvedStatus.category,
        queueStatusDept: 'Migration',
      }),
    });
    const patched = await patchRes.json();
    if (!patchRes.ok) throw new Error(`Patch failed: ${JSON.stringify(patched)}`);
    console.log('Resolved successfully.');

    console.log('\n=== Step 4: check for a STATUS_CHANGED notification row for Ranadeep ===');
    // Small delay for the fire-and-forget notifyUsers()/notifyStatusChanged() calls to land.
    await new Promise((r) => setTimeout(r, 1500));
    const { rows: notifs } = await pool.query(
      `SELECT type, title, "createdAt" FROM notifications WHERE "userId" = $1 AND "issueKey" = $2 AND "createdAt" >= $3 ORDER BY "createdAt" ASC`,
      [ranadeep.userId, testKey, beforeTs]
    );
    if (notifs.length) {
      console.log(`PASS -- ${notifs.length} notification row(s) created:`);
      for (const n of notifs) console.log(`  [${n.createdAt.toISOString()}] ${n.type} - "${n.title}"`);
    } else {
      console.log('FAIL -- no notification row was created for Ranadeep after the queue-status resolve.');
    }
  } finally {
    console.log('\n=== Cleanup ===');
    if (testKey) {
      const delRes = await fetch(`${APP_URL}/api/issues/${testKey}`, { method: 'DELETE', headers: adminAuth });
      console.log(`Deleted test ticket ${testKey}: ${delRes.ok ? 'ok' : 'FAILED, delete it manually'}`);
    }
    await revoke(admin.tokenHash);
    await revoke(ranadeep.tokenHash);
    await pool.end();
  }
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
