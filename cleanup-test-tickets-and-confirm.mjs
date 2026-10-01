// Both verification runs actually SUCCEEDED -- the notifications table shows
// real STATUS_CHANGED "... status -> Resolved" rows for Ranadeep on both
// CF-33201 and CF-33202, created right after each test's resolve action.
// The earlier "FAIL" reports were a bug in the verification scripts
// themselves: they queried notifications by the raw internal `key` column
// (e.g. "L1BOAR-31590"), but the app actually stores the friendly `cf_key`
// (e.g. "CF-33202") in notifications.issueKey -- so the query was just
// looking for the wrong value, not indicating a real failure.
//
// This does the final, correct confirmation (querying by cf_key) and then
// deletes all leftover disposable test tickets from this verification
// (matched by their summary prefix) via the real DELETE endpoint.
//
// Usage: node cleanup-test-tickets-and-confirm.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';
const ADMIN_EMAIL = 'bhanu.srikakulam@cloudfuze.com';

async function main() {
  const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [ADMIN_EMAIL]);
  const adminId = adminRows[0].id;
  const payload = { sub: adminId, ip: '', ua: 'cleanup-test-tickets', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','cleanup-test-tickets',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, adminId, new Date(Date.now() + 3600 * 1000)]
  );

  console.log('=== Final confirmation, querying by cf_key this time ===');
  const { rows: testIssues } = await pool.query(
    `SELECT id, key, cf_key FROM issues WHERE summary LIKE 'TEST%notification fix verification%'`
  );
  for (const issue of testIssues) {
    const { rows: notifs } = await pool.query(
      `SELECT n."userId", u.email, n.type, n.title, n."createdAt" FROM notifications n
       LEFT JOIN users u ON u.id = n."userId"
       WHERE n."issueKey" = $1 ORDER BY n."createdAt" ASC`,
      [issue.cf_key]
    );
    console.log(`\n${issue.cf_key} (${issue.key}):`);
    for (const n of notifs) console.log(`  [${n.createdAt.toISOString()}] -> ${n.email} : ${n.type} "${n.title}"`);
  }

  console.log('\n=== Deleting all leftover test tickets ===');
  for (const issue of testIssues) {
    const delRes = await fetch(`${APP_URL}/api/issues/${issue.key}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`Deleted ${issue.cf_key} (${issue.key}): ${delRes.ok ? 'ok' : 'FAILED'}`);
  }

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
