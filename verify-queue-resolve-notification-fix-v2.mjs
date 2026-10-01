// v1 of this verification FAILED (no notification row appeared), which is
// surprising given the fix was deployed. v1 deleted the test ticket
// immediately after, losing the ability to inspect why. This version keeps
// the ticket around and prints full diagnostics after each step: the
// ticket's actual current_department/assigneeId/reporterId/dept_statuses
// right after creation (to rule out a test-setup problem, e.g. reporterId
// silently not being honored at creation -- the create handler only reads
// body.reporterEmail, not body.reporterId, for the reporter), then every
// issue_history row and every notification row (for ANYONE, not just
// Ranadeep) created by the resolve PATCH, to see exactly which code branch
// actually ran.
//
// Does NOT delete the test ticket -- clean it up manually once done:
//   node -e "..." or via the app, using the key this prints.
//
// Usage: node verify-queue-resolve-notification-fix-v2.mjs

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

async function main() {
  const admin = await makeSessionToken(ADMIN_EMAIL, 'verify-notif-fix-v2-admin');
  const ranadeep = await makeSessionToken(RANADEEP_EMAIL, 'verify-notif-fix-v2-ranadeep-lookup');
  const adminAuth = { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' };

  console.log('=== Step 1: create disposable test ticket ===');
  const createRes = await fetch(`${APP_URL}/api/issues`, {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({
      spaceKey: 'TESTIN', summary: 'TEST v2 - notification fix verification (safe to delete)',
      type: 'task', priority: 'low', department: 'Migration',
      assigneeId: ranadeep.userId, reporterEmail: RANADEEP_EMAIL,
    }),
  });
  const created = await createRes.json();
  if (!createRes.ok || !created?.key) throw new Error(`Create failed: ${JSON.stringify(created)}`);
  const testKey = created.key;
  console.log(`Created ${created.cf_key || created.key}`);

  console.log('\n=== Step 1b: raw DB state right after creation ===');
  const { rows: raw1 } = await pool.query(
    `SELECT id, key, cf_key, current_department, "assigneeId", "reporterId", "statusId", dept_statuses FROM issues WHERE key = $1`,
    [testKey]
  );
  console.log(JSON.stringify(raw1[0], null, 2));
  console.log(`assigneeId matches Ranadeep: ${raw1[0].assigneeId === ranadeep.userId}`);
  console.log(`reporterId matches Ranadeep: ${raw1[0].reporterId === ranadeep.userId}`);

  console.log('\n=== Step 2: find Migration queue\'s real "Resolved" status ===');
  const cq = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = cq.rows[0]?.queues || [];
  const migrationQueue = queues.find((q) => String(q.name || '').toLowerCase() === 'migration');
  const resolvedStatus = (migrationQueue?.queueStatuses || []).find((s) => (s.name || '').toLowerCase() === 'resolved');
  console.log(`Found: ${JSON.stringify(resolvedStatus)}`);

  const beforeTs = new Date();

  console.log('\n=== Step 3: admin resolves it via the queue status dropdown\'s own PATCH shape ===');
  const patchBody = {
    queueStatusId: resolvedStatus.id, queueStatusName: resolvedStatus.name,
    queueStatusColor: resolvedStatus.color, queueStatusCategory: resolvedStatus.category,
    queueStatusDept: 'Migration',
  };
  console.log(`PATCH body: ${JSON.stringify(patchBody)}`);
  const patchRes = await fetch(`${APP_URL}/api/issues/${testKey}`, { method: 'PATCH', headers: adminAuth, body: JSON.stringify(patchBody) });
  const patched = await patchRes.json();
  console.log(`PATCH response ok=${patchRes.ok} status=${patchRes.status}`);
  if (!patchRes.ok) console.log(`Response body: ${JSON.stringify(patched)}`);

  await new Promise((r) => setTimeout(r, 1500));

  console.log('\n=== Step 4: raw DB state after PATCH ===');
  const { rows: raw2 } = await pool.query(
    `SELECT current_department, "assigneeId", "reporterId", "statusId", dept_statuses FROM issues WHERE key = $1`,
    [testKey]
  );
  console.log(JSON.stringify(raw2[0], null, 2));

  console.log('\n=== Step 5: issue_history rows created by the PATCH ===');
  const { rows: hist } = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorEmail", "createdAt" FROM issue_history WHERE "issueId" = $1 AND "createdAt" >= $2 ORDER BY "createdAt" ASC`,
    [raw1[0].id, beforeTs]
  );
  for (const h of hist) console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" (by ${h.authorEmail})`);
  if (!hist.length) console.log('  (none)');

  console.log('\n=== Step 6: ALL notification rows for this issueKey (any user) ===');
  const { rows: allNotifs } = await pool.query(
    `SELECT n."userId", u.email, n.type, n.title, n."createdAt" FROM notifications n
     LEFT JOIN users u ON u.id = n."userId"
     WHERE n."issueKey" = $1 AND n."createdAt" >= $2 ORDER BY n."createdAt" ASC`,
    [testKey, beforeTs]
  );
  for (const n of allNotifs) console.log(`  [${n.createdAt.toISOString()}] -> ${n.email} : ${n.type} "${n.title}"`);
  if (!allNotifs.length) console.log('  (none at all, for anyone)');

  console.log(`\nTest ticket key for manual cleanup: ${testKey}`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
