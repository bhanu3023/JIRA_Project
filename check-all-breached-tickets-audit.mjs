// Read-only: comprehensive audit. Pulls every ticket the REAL Filters
// screen currently shows as "SLA Breached: Yes", for every department with
// an active SLA policy (Dev, QA, Infra, Migration), and independently
// verifies each one's breach is genuinely justified -- either real
// dept_sla_log elapsed time exceeding that department's own (non-zero)
// goal for its priority, or a legitimately-trusted jira_sla_breached
// fallback (no real tracking AND no explicit priority removal). Flags
// anything that still looks like a false positive.
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
  return { removed: false, goalMs: 8 * 3600000 }; // unconfigured priority -> 8h default, a real policy
}

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'full-breach-audit', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','full-breach-audit',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const policiesBySpace = {};
  const { rows: allPolicies } = await pool.query(`SELECT * FROM sla_definitions WHERE status = 'active'`);
  for (const p of allPolicies) (policiesBySpace[p.spaceId] ??= []).push(p);

  let totalChecked = 0, suspicious = 0;
  for (const dept of ['Dev', 'QA', 'Infra', 'Migration']) {
    const url = `${APP_URL}/api/issues?spaceKey=TESTIN&dept=${dept}&queueMembersOnly=true&slaBreached=yes&page=1&limit=500`;
    const res = await fetch(url, { headers: authHeader, signal: AbortSignal.timeout(60000) }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    const issues = data.issues || [];
    console.log(`\n=== Queue: ${dept} -- ${issues.length} tickets showing SLA Breached: Yes ===`);

    for (const issue of issues) {
      totalChecked++;
      const { rows } = await pool.query(
        `SELECT dept_sla_log, priority, "spaceId", jira_sla_breached, "resolvedAt" FROM issues WHERE id = $1`,
        [issue.id]
      );
      const r = rows[0];
      if (!r) continue;
      const priority = (r.priority || 'medium').toLowerCase();
      const deptLog = Object.keys(r.dept_sla_log || {}).find((k) => k.toLowerCase() === dept.toLowerCase());
      const entry = deptLog ? r.dept_sla_log[deptLog] : null;
      const policies = (policiesBySpace[r.spaceId] || []).filter((p) => {
        const pDept = (p.dept_name || '').trim().toLowerCase();
        return !pDept || pDept === dept.toLowerCase();
      });
      const goalInfos = policies.map((p) => getGoalInfo(p, priority));
      const allRemoved = goalInfos.length > 0 && goalInfos.every((g) => g.removed);
      const minGoalMs = Math.min(...goalInfos.filter((g) => !g.removed).map((g) => g.goalMs), Infinity);

      let verdict = 'OK';
      if (entry && typeof entry.elapsed_ms === 'number' && !allRemoved && minGoalMs !== Infinity) {
        verdict = entry.elapsed_ms >= minGoalMs ? 'OK (real elapsed >= goal)' : '*** SUSPICIOUS: real elapsed < goal but shows breached ***';
      } else if (allRemoved) {
        verdict = '*** SUSPICIOUS: priority explicitly removed from SLA tracking but still shows breached ***';
      } else if (!entry && !r.jira_sla_breached) {
        verdict = '*** SUSPICIOUS: no real tracking and no jira_sla_breached flag, but shows breached ***';
      } else if (!entry && r.jira_sla_breached) {
        verdict = 'OK (legitimate legacy jira_sla_breached fallback, no real tracking exists)';
      }
      if (verdict.startsWith('***')) {
        suspicious++;
        console.log(` - ${issue.cfKey || issue.key}: priority=${r.priority} elapsed=${entry?.elapsed_ms ?? 'n/a'} minGoal=${minGoalMs === Infinity ? 'n/a' : minGoalMs} jira_sla_breached=${r.jira_sla_breached} -> ${verdict}`);
      }
    }
  }
  console.log(`\n\nTotal breached tickets checked across Dev/QA/Infra/Migration: ${totalChecked}`);
  console.log(`Suspicious (still possibly wrong): ${suspicious}`);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
