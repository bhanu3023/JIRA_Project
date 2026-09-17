// For QA, Infra, Dev (Customer Engineering), and Migration (ENT+SMB), pulls
// every ticket the real live /api/issues endpoint currently flags as
// "SLA Breached: Yes" for that queue (Queue:<dept> + slaBreached=yes,
// queueMembersOnly) and checks two things per row:
//
//   1. Is the shown Assignee actually a member of that queue's roster?
//      (same class of check as check-infra-assignee-accuracy.mjs)
//   2. Does sla_breached_dept (what the row says the breach belongs to)
//      actually match the department this row was fetched under? The
//      backend always sets sla_breached_dept = current_department
//      (jira-pg-api.ts ~line 6819), but the breach boolean itself is
//      computed against the QUERIED department's own SLA clock
//      (deptParam, ~line 6628) -- for a ticket that breached in this
//      queue's own department and has since moved to a different
//      current_department, those two can disagree: the row is correctly
//      flagged "Yes" under THIS queue, but the department label shown
//      next to it names wherever the ticket lives NOW, not the queue
//      that actually breached it.
//
// Read-only.
//
// Usage: node check-sla-breach-accuracy.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';

const QUEUES = ['QA', 'Infra', 'Dev', 'Migration'];
// Migration is a single, undivided Filters queue (no live ENT/SMB split --
// see TEAM_ROSTER's own comment in jira-pg-api.ts), so its roster here is
// the union of both fixed MBR rosters, same people Filters' own "Queue:
// Migration" would draw from once assigned.
const MIGRATION_ROSTER = [
  'abhishek.sakala@cloudfuze.com', 'arun@cloudfuze.com', 'chaitanya.gupta@cloudfuze.com', 'chandra.mouli@cloudfuze.com',
  'davidraj.dumpala@cloudfuze.com', 'ganesh.kondameedi@cloudfuze.com', 'harshith.kaduluri@cloudfuze.com', 'lakshmareddy@cloudfuze.com',
  'lakshmi.prasanna@cloudfuze.com', 'manoj.bathula@cloudfuze.com', 'pallavi.kosuvaripalli@cloudfuze.com', 'pranavi@cloudfuze.com',
  'abhishikth.yenugula@cloudfuze.com', 'ajay.singh@cloudfuze.com', 'ramana.reddy@cloudfuze.com', 'amulya.anapuram@cloudfuze.com',
  'dathu.kaluvala@cloudfuze.com', 'habeebunnisa.begum@cloudfuze.com', 'harika.velidi@cloudfuze.com', 'meena.lakshmi@cloudfuze.com',
  'neelima.krotta@cloudfuze.com', 'raghu.yellani@cloudfuze.com', 'ranadeep.muddam@cloudfuze.com', 'ravi.hemanth@cloudfuze.com',
  'saikumar.kustapuram@cloudfuze.com', 'siva.kota@cloudfuze.com', 'sravan.kesaram@cloudfuze.com', 'sriram.ramakrishnan@cloudfuze.com',
  'swaroop@cloudfuze.com', 'vijendar.burgula@cloudfuze.com', 'vineetha.yenti@cloudfuze.com',
];

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'sla-breach-accuracy-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','sla-breach-accuracy-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return token;
}

async function rosterFor(dept) {
  if (dept === 'Migration') return new Set(MIGRATION_ROSTER.map((e) => e.toLowerCase()));
  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues`);
  const set = new Set();
  for (const row of cqRows) {
    const queues = Array.isArray(row.queues) ? row.queues : [];
    for (const q of queues) {
      if (String(q?.name || '').trim().toLowerCase() === dept.toLowerCase()) {
        for (const m of (q.memberIds || [])) set.add(m);
      }
    }
  }
  // memberIds are user ids, not emails -- resolve so this can be compared
  // against the API response's assignee.email the same way as Migration's.
  if (!set.size) return set;
  const { rows: userRows } = await pool.query(`SELECT id, email FROM users WHERE id = ANY($1::text[])`, [Array.from(set)]);
  return new Set(userRows.map((u) => String(u.email || '').toLowerCase()).filter(Boolean));
}

async function main() {
  const token = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  for (const dept of QUEUES) {
    const roster = await rosterFor(dept);
    const params = new URLSearchParams({
      spaceKey: 'TESTIN', dept, queueMembersOnly: 'true', slaBreached: 'yes',
      page: '1', limit: '500',
    });
    const res = await fetch(`${APP_URL}/api/issues?${params}`, { headers: authHeader });
    const data = await res.json();
    if (!res.ok) { console.log(`\n=== Queue: ${dept} === ERR ${res.status}`, data); continue; }
    const issues = data.issues || data.data || [];
    console.log(`\n=== Queue: ${dept} — ${issues.length} ticket(s) flagged SLA Breached: Yes (reported total: ${data.total}) ===`);

    const assigneeMismatches = issues.filter((i) => i.assignee && !roster.has(String(i.assignee.email || '').toLowerCase()));
    const deptMismatches = issues.filter((i) => String(i.sla_breached_dept || i.current_department || '').toLowerCase() !== dept.toLowerCase());

    console.log(`  Assignee NOT on ${dept} roster: ${assigneeMismatches.length} / ${issues.length}`);
    for (const i of assigneeMismatches) {
      const key = i.cf_key || i.key;
      const shown = i.assignee ? `${i.assignee.firstName} ${i.assignee.lastName} <${i.assignee.email}>` : '(none)';
      console.log(`    ${key}  assignee=${shown}  current_dept=${i.current_department}`);
    }

    console.log(`  sla_breached_dept mismatched with queried dept (${dept}): ${deptMismatches.length} / ${issues.length}`);
    for (const i of deptMismatches) {
      const key = i.cf_key || i.key;
      console.log(`    ${key}  sla_breached_dept=${i.sla_breached_dept}  current_dept=${i.current_department}  sla_breached_by=${i.sla_breached_by}`);
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
