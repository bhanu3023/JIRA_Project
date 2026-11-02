// Read-only, comprehensive: for EVERY ticket in every queue (Dev/QA/Infra/
// Migration), not just the ones currently shown as breached, compare the
// shown sla_breached flag against the real cumulative elapsed-vs-goal time
// computed straight from dept_sla_log (correcting a running entry's elapsed
// to (now - started_at) instead of trusting the stale stored elapsed_ms).
// Checks BOTH directions: false positive (shown breached, isn't really) and
// false negative (shown not breached, really is). Also cross-checks every
// genuinely-breached ticket has a real "SLA breached — <Dept> (<Name>)"
// History entry (the "dry run of history" check).
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
  const payload = { sub: userId, ip: '', ua: 'full-ticket-audit', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','full-ticket-audit',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function fetchAllPages(authHeader, dept) {
  const all = [];
  for (let page = 1; page <= 40; page++) {
    const url = `${APP_URL}/api/issues?spaceKey=TESTIN&dept=${dept}&queueMembersOnly=true&page=${page}&limit=500`;
    const res = await fetch(url, { headers: authHeader, signal: AbortSignal.timeout(60000) }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    const issues = data.issues || [];
    all.push(...issues);
    if (issues.length < 500) break;
  }
  return all;
}

async function main() {
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const policiesBySpace = {};
  const { rows: allPolicies } = await pool.query(`SELECT * FROM sla_definitions WHERE status = 'active'`);
  for (const p of allPolicies) (policiesBySpace[p.spaceId] ??= []).push(p);

  let totalChecked = 0, falsePositives = 0, falseNegatives = 0, matched = 0, noPolicy = 0, missingHistory = 0;

  for (const dept of ['Dev', 'QA', 'Infra', 'Migration']) {
    const issues = await fetchAllPages(authHeader, dept);
    console.log(`\n=== Queue: ${dept} -- ${issues.length} total tickets ===`);

    for (const issue of issues) {
      totalChecked++;
      const shownBreached = !!issue.sla_breached;
      const { rows } = await pool.query(`
        SELECT i.id, i.dept_sla_log, i.priority, i."spaceId", i.jira_sla_breached, i."createdAt",
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

      if (allRemoved || minGoalMs === Infinity) {
        // No real policy applies to this dept/priority -- the only way
        // "breached" can legitimately show true is the imported legacy flag,
        // and only when there's truly no real dept tracking at all.
        if (shownBreached && (entry || !r.jira_sla_breached)) {
          falsePositives++;
          console.log(` - FALSE POSITIVE (no real policy applies): ${issue.cfKey || issue.key} priority=${r.priority}`);
        } else {
          noPolicy++;
        }
        continue;
      }

      let realElapsedMs;
      if (entry) {
        realElapsedMs = entry.status === 'running' && !isCurrentlyResolved
          ? (entry.elapsed_ms || 0) + (Date.now() - new Date(entry.started_at).getTime())
          : (entry.elapsed_ms || 0);
      } else {
        const startMs = r.dept_sla_started_at ? new Date(r.dept_sla_started_at).getTime() : new Date(r.createdAt).getTime();
        realElapsedMs = Date.now() - startMs;
      }
      const real = realElapsedMs >= minGoalMs;

      if (shownBreached === real) {
        matched++;
      } else if (shownBreached && !real) {
        falsePositives++;
        console.log(` - FALSE POSITIVE: ${issue.cfKey || issue.key} shown breached=true but real elapsed=${(realElapsedMs/3600000).toFixed(1)}h < goal=${(minGoalMs/3600000).toFixed(1)}h`);
      } else {
        falseNegatives++;
        console.log(` - FALSE NEGATIVE: ${issue.cfKey || issue.key} shown breached=false but real elapsed=${(realElapsedMs/3600000).toFixed(1)}h >= goal=${(minGoalMs/3600000).toFixed(1)}h`);
      }

      // Dry-run History check: every genuinely-breached ticket should have a
      // real "SLA breached — <Dept> (<Name>)" entry recorded for this dept.
      if (real) {
        const { rows: histRows } = await pool.query(
          `SELECT 1 FROM issue_history WHERE "issueId" = $1 AND field = 'sla' AND "newValue" ILIKE $2 LIMIT 1`,
          [r.id, `SLA breached — ${dept}%`]
        );
        if (!histRows.length) {
          missingHistory++;
          console.log(` - MISSING HISTORY: ${issue.cfKey || issue.key} is genuinely breached in ${dept} but has no "SLA breached — ${dept}" History entry`);
        }
      }
    }
  }

  console.log(`\n\n=== SUMMARY ===`);
  console.log(`Total tickets checked across Dev/QA/Infra/Migration: ${totalChecked}`);
  console.log(`Matched (shown verdict = real verdict): ${matched}`);
  console.log(`No real policy applies (correctly excluded): ${noPolicy}`);
  console.log(`False positives (shown breached, really isn't): ${falsePositives}`);
  console.log(`False negatives (shown not breached, really is): ${falseNegatives}`);
  console.log(`Genuinely breached tickets missing a History entry: ${missingHistory}`);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
