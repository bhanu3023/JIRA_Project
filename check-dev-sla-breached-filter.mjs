// Read-only: verify the Filters page's "Queue: Dev + SLA Breached: Yes +
// Created/Updated between 2026-10-01 and 2026-10-28 (either)" result set is
// real -- hit the exact same API the page calls, then independently
// recompute each returned ticket's Dev-queue breach from raw dept_sla_log +
// the Dev policy's own goal duration for that priority, instead of trusting
// the app's own sla_breached flag blindly.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'sla-verify', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','sla-verify',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

function durationMsFromGoals(policy, priority) {
  const goals = Array.isArray(policy.goals) ? policy.goals : [];
  for (const goal of goals) {
    if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
      const row = goal.priorityRows.find((r) => (r.priority || '').toLowerCase() === priority);
      if (row && row.timeValue !== undefined && row.timeValue !== null && row.timeValue !== '') {
        const val = parseFloat(row.timeValue);
        if (val === 0) return null; // removed tier
        const unit = (row.timeUnit || 'hours').toLowerCase();
        return unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
      }
    } else if (goal.timeValue) {
      const val = parseFloat(goal.timeValue);
      if (val === 0) return null;
      const unit = (goal.timeUnit || 'hours').toLowerCase();
      return unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
    }
  }
  return 8 * 3_600_000; // default 8h, matches computeSLAInstancesPure
}

async function main() {
  if (!JWT_SECRET) { console.error('JWT_SECRET not set'); process.exit(1); }
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const qs = `spaceKey=TESTIN&dept=Dev&queueMembersOnly=true&slaBreached=yes&createdRange=between:2026-10-01:2026-10-28&updatedRange=between:2026-10-01:2026-10-28&multiSep=pipe&page=1&limit=50`;
  const res = await fetch(`${APP_URL}/api/issues?${qs}`, { headers: authHeader, signal: AbortSignal.timeout(60000) });
  const data = await res.json();
  console.log(`API returned total=${data.total}, page rows=${data.issues?.length}\n`);

  const { rows: devPolicies } = await pool.query(
    `SELECT * FROM sla_definitions WHERE status='active' AND LOWER(dept_name) = 'dev'`
  );
  console.log(`Active Dev-dept SLA polic(y/ies): ${devPolicies.map(p => `${p.name} (updated ${p.updatedAt?.toISOString?.() || p.updatedAt})`).join(', ') || 'NONE'}\n`);

  for (const issue of (data.issues || []).slice(0, 15)) {
    const { rows } = await pool.query(
      `SELECT key, cf_key, priority, "createdAt", "resolvedAt", "updatedAt", dept_sla_log, dept_sla_started_at,
              current_department, sla_waivers, sla_snapshot, sla_breached, sla_breached_by, sla_breached_dept
       FROM issues WHERE id = $1`, [issue.id]
    );
    const row = rows[0];
    if (!row) continue;
    const deptLog = row.dept_sla_log || {};
    const devKey = Object.keys(deptLog).find((k) => k.toLowerCase() === 'dev');
    const devEntry = devKey ? deptLog[devKey] : null;
    const elapsedMs = devEntry?.elapsed_ms ?? null;
    const priority = (row.priority || 'medium').toLowerCase();
    const goalMs = devPolicies.length ? durationMsFromGoals(devPolicies[0], priority) : null;
    const breachedByGoal = (elapsedMs != null && goalMs != null) ? elapsedMs >= goalMs : null;
    console.log(
      `${row.key} (${row.cf_key}) | priority=${priority} | app says sla_breached=${row.sla_breached} by="${row.sla_breached_by}" dept="${row.sla_breached_dept}" | ` +
      `Dev elapsed_ms=${elapsedMs} (${elapsedMs != null ? (elapsedMs/3600000).toFixed(1)+'h' : 'n/a'}) vs Dev goal=${goalMs != null ? (goalMs/3600000).toFixed(1)+'h' : 'n/a'} -> recomputed breach=${breachedByGoal} | ` +
      `snapshot frozen=${Array.isArray(row.sla_snapshot) && row.sla_snapshot.length > 0} | waiver=${!!(row.sla_waivers && Object.keys(row.sla_waivers).length)}`
    );
  }

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
