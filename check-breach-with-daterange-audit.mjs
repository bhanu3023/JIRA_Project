// Read-only: same corrected breach-verification logic as
// check-all-breached-tickets-audit-v2.mjs, but run WITH real date-range
// params combined with Queue + SLA Breached: Yes -- the exact combination
// being asked about. Tests multiple common range combos to confirm
// accuracy holds no matter which date fields/range a user picks.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

function getGoalInfo(policy, priority) {
  for (const goal of (policy.goals || [])) {
    if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
      const row = goal.priorityRows.find((r) => (r.priority || '').toLowerCase() === priority);
      if (row && row.timeValue !== undefined && row.timeValue !== null && row.timeValue !== '') {
        const val = parseFloat(row.timeValue);
        if (val === 0) return { removed: true };
        const unit = (row.timeUnit || 'hours').toLowerCase();
        const ms = unit === 'minutes' ? val * 60000 : unit === 'days' ? val * 86400000 : val * 3600000;
        return { removed: false, goalMs: ms };
      }
    } else if (goal.timeValue !== undefined && goal.timeValue !== null && goal.timeValue !== '') {
      const val = parseFloat(goal.timeValue);
      if (val === 0) return { removed: true };
      const unit = (goal.timeUnit || 'hours').toLowerCase();
      const ms = unit === 'minutes' ? val * 60000 : unit === 'days' ? val * 86400000 : val * 3600000;
      return { removed: false, goalMs: ms };
    }
  }
  return { removed: false, goalMs: 8 * 3600000 };
}

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'breach-daterange-audit', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','breach-daterange-audit',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function verifyOne(issue, dept, policiesBySpace) {
  const { rows } = await pool.query(`
    SELECT i.dept_sla_log, i.priority, i."spaceId", i.jira_sla_breached, i."createdAt",
           i.dept_sla_started_at, s.category AS status_category
    FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE i.id = $1
  `, [issue.id]);
  const r = rows[0];
  if (!r) return 'OK';
  const priority = (r.priority || 'medium').toLowerCase();
  const isCurrentlyResolved = r.status_category === 'done';
  const deptLogKey = Object.keys(r.dept_sla_log || {}).find((k) => k.toLowerCase() === dept.toLowerCase());
  const entry = deptLogKey ? r.dept_sla_log[deptLogKey] : null;
  const policies = (policiesBySpace[r.spaceId] || []).filter((p) => {
    const pDept = (p.dept_name || '').trim().toLowerCase();
    return !pDept || pDept === dept.toLowerCase();
  });
  const goalInfos = policies.map((p) => getGoalInfo(p, priority));
  const allRemoved = goalInfos.length > 0 && goalInfos.every((g) => g.removed);
  const minGoalMs = Math.min(...goalInfos.filter((g) => !g.removed).map((g) => g.goalMs), Infinity);

  let realElapsedMs;
  if (entry) {
    realElapsedMs = entry.status === 'running' && !isCurrentlyResolved
      ? (entry.elapsed_ms || 0) + (Date.now() - new Date(entry.started_at).getTime())
      : (entry.elapsed_ms || 0);
  } else {
    const startMs = r.dept_sla_started_at ? new Date(r.dept_sla_started_at).getTime() : new Date(r.createdAt).getTime();
    realElapsedMs = Date.now() - startMs;
  }

  if (allRemoved) return 'SUSPICIOUS: priority removed from tracking but breached';
  if (minGoalMs !== Infinity) return realElapsedMs >= minGoalMs ? 'OK' : 'SUSPICIOUS: elapsed < goal but breached';
  if (!entry && !r.jira_sla_breached) return 'SUSPICIOUS: no policy, no tracking, no jira flag, but breached';
  return 'OK';
}

async function main() {
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };
  const policiesBySpace = {};
  const { rows: allPolicies } = await pool.query(`SELECT * FROM sla_definitions WHERE status = 'active'`);
  for (const p of allPolicies) (policiesBySpace[p.spaceId] ??= []).push(p);

  const combos = [
    { label: 'Created+Resolved, Oct 1-30', params: 'createdRange=between:2026-10-01:2026-10-30&resolvedRange=between:2026-10-01:2026-10-30' },
    { label: 'Created+Updated, Oct 1-30',  params: 'createdRange=between:2026-10-01:2026-10-30&updatedRange=between:2026-10-01:2026-10-30' },
    { label: 'Created only, last 30d',     params: 'createdRange=30d' },
    { label: 'Updated only, last 7d',      params: 'updatedRange=7d' },
    { label: 'Resolved only, Sep 2026',    params: 'resolvedRange=between:2026-09-01:2026-09-30' },
  ];

  for (const combo of combos) {
    console.log(`\n\n########## ${combo.label} ##########`);
    let totalChecked = 0, suspicious = 0;
    for (const dept of ['Dev', 'QA', 'Infra', 'Migration']) {
      const url = `${APP_URL}/api/issues?spaceKey=TESTIN&dept=${dept}&queueMembersOnly=true&slaBreached=yes&${combo.params}&page=1&limit=500`;
      const res = await fetch(url, { headers: authHeader, signal: AbortSignal.timeout(60000) }).catch(() => null);
      const data = res ? await res.json().catch(() => ({})) : {};
      const issues = data.issues || [];
      for (const issue of issues) {
        totalChecked++;
        const verdict = await verifyOne(issue, dept, policiesBySpace);
        if (verdict !== 'OK') { suspicious++; console.log(` - [${dept}] ${issue.cfKey || issue.key}: ${verdict}`); }
      }
    }
    console.log(`Checked: ${totalChecked}, Suspicious: ${suspicious}`);
  }

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
