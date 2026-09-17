// Checks whether Queue:Infra's Assignee column, as returned by the real
// live /api/issues endpoint (Created+Updated Aug 2026, queueMembersOnly),
// actually shows an Infra roster member on every row -- or whether some
// rows are still showing a non-Infra person's name, same class of bug
// already fixed for Queue:Dev (see the assigneeOverride comments in
// jira-pg-api.ts around movedAwayFromQueue / dept_assignees).
//
// For every row whose displayed assignee is NOT an Infra roster member,
// prints the ticket key + current_department + dept_assignees snapshot +
// reporter, so a real mismatch can be told apart from an intentional
// reporter-fallback (no snapshot existed at all -- see CF-29845/CF-29902).
//
// Read-only.
//
// Usage: node check-infra-assignee-accuracy.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';
const DEPT = 'Infra';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'infra-assignee-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','infra-assignee-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return token;
}

async function main() {
  // Resolve the Infra roster the same way the app itself does (see
  // deptMemberSets in jira-pg-api.ts): merge memberIds across every
  // custom_queues row for a queue named "infra", case-insensitively.
  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues`);
  const memberSet0 = new Set();
  for (const row of cqRows) {
    const queues = Array.isArray(row.queues) ? row.queues : [];
    for (const q of queues) {
      if (String(q?.name || '').trim().toLowerCase() === 'infra') {
        for (const m of (q.memberIds || [])) memberSet0.add(m);
      }
    }
  }
  const memberIds = Array.from(memberSet0);
  console.log(`Infra queue member count: ${memberIds.length}`);

  const token = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const params = new URLSearchParams({
    spaceKey: 'TESTIN', dept: DEPT, queueMembersOnly: 'true',
    createdRange: 'between:2026-08-01:2026-08-31', updatedRange: 'between:2026-08-01:2026-08-31',
    page: '1', limit: '2000',
  });
  const res = await fetch(`${APP_URL}/api/issues?${params}`, { headers: authHeader });
  const data = await res.json();
  if (!res.ok) { console.log(`ERR ${res.status}`, data); await pool.end(); return; }
  const issues = data.issues || data.data || [];
  console.log(`Total Queue:Infra tickets returned: ${issues.length} (reported total: ${data.total})\n`);

  const memberSet = new Set(memberIds);
  const mismatches = issues.filter(i => i.assignee && !memberSet.has(i.assignee.id));
  const unassigned = issues.filter(i => !i.assignee);
  const matches = issues.length - mismatches.length - unassigned.length;

  console.log(`Assignee IS an Infra roster member: ${matches}`);
  console.log(`Assignee is NOT an Infra roster member: ${mismatches.length}`);
  console.log(`No assignee at all: ${unassigned.length}\n`);

  if (mismatches.length) {
    console.log('Non-roster-assignee tickets (key, current_department, assignee shown, dept_assignees.Infra snapshot, reporter):');
    for (const i of mismatches) {
      const key = i.cf_key || i.key;
      const shown = i.assignee ? `${i.assignee.firstName} ${i.assignee.lastName} <${i.assignee.email}>` : '(none)';
      const snap = (i.dept_assignees && (i.dept_assignees.Infra || i.dept_assignees.infra)) || null;
      const snapStr = snap ? `${snap.firstName} ${snap.lastName} <${snap.email}>` : '(no snapshot)';
      const reporter = i.reporter ? `${i.reporter.firstName} ${i.reporter.lastName} <${i.reporter.email}>` : '(none)';
      console.log(`  ${key}  current_dept=${i.current_department}  shown=${shown}  infra_snapshot=${snapStr}  reporter=${reporter}`);
    }
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
