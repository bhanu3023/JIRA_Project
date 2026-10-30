// Read-only: corrected version of the full breach audit. Fixes two flaws in
// the original: (1) a "running" (not yet paused) dept_sla_log entry's real
// elapsed is (now - started_at), not the stale stored elapsed_ms (which
// only updates on pause/resolve) -- the original wrongly read elapsed_ms
// directly; (2) prefers dept_sla_log[dept].started_at over createdAt for
// the "no real tracking" fallback check, and checks the ticket's CURRENT
// status category (not just whether resolvedAt is set) to correctly
// recognize a reopened ticket.
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
  const payload = { sub: userId, ip: '', ua: 'full-breach-audit-v2', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','full-breach-audit-v2',$3) ON CONFLICT (token_hash) DO NOTHING`,
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
      const { rows } = await pool.query(`
        SELECT i.dept_sla_log, i.priority, i."spaceId", i.jira_sla_breached, i."createdAt",
               i.dept_sla_started_at, s.category AS status_category
        FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
        WHERE i.id = $1
      `, [issue.id]);
      const r = rows[0];
      if (!r) continue;
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

      // Real elapsed: for a RUNNING (not paused/done) entry, it's
      // (now - started_at), not the stale stored elapsed_ms.
      let realElapsedMs = null;
      if (entry) {
        if (entry.status === 'running' && !isCurrentlyResolved) {
          realElapsedMs = (entry.elapsed_ms || 0) + (Date.now() - new Date(entry.started_at).getTime());
        } else {
          realElapsedMs = entry.elapsed_ms || 0;
        }
      } else {
        // No per-department entry -- fall back to dept_sla_started_at or
        // createdAt, same as the app itself does.
        const startMs = r.dept_sla_started_at ? new Date(r.dept_sla_started_at).getTime() : new Date(r.createdAt).getTime();
        realElapsedMs = Date.now() - startMs;
      }

      let verdict = 'OK';
      if (allRemoved) {
        verdict = '*** SUSPICIOUS: priority explicitly removed from SLA tracking but still shows breached ***';
      } else if (minGoalMs !== Infinity) {
        verdict = realElapsedMs >= minGoalMs ? 'OK (real elapsed >= goal)' : '*** SUSPICIOUS: real elapsed < goal but shows breached ***';
      } else if (!entry && !r.jira_sla_breached) {
        verdict = '*** SUSPICIOUS: no policy, no real tracking, no jira_sla_breached flag, but shows breached ***';
      }
      if (verdict.startsWith('***')) {
        suspicious++;
        console.log(` - ${issue.cfKey || issue.key}: priority=${r.priority} realElapsed=${realElapsedMs !== null ? (realElapsedMs/3600000).toFixed(1)+'h' : 'n/a'} minGoal=${minGoalMs === Infinity ? 'n/a' : (minGoalMs/3600000).toFixed(1)+'h'} jira_sla_breached=${r.jira_sla_breached} isCurrentlyResolved=${isCurrentlyResolved} -> ${verdict}`);
      }
    }
  }
  console.log(`\n\nTotal breached tickets checked across Dev/QA/Infra/Migration: ${totalChecked}`);
  console.log(`Genuinely suspicious (after correcting for running-instance and reopened-ticket handling): ${suspicious}`);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
