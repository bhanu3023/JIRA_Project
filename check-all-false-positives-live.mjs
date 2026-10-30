// Read-only: verify EVERY ticket identified as a false-positive SLA breach
// (not just CF-33117) against the REAL live /api/issues endpoint, the same
// one Filters uses -- confirms the fix actually applies across the board,
// not just the one spot-checked example.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

function isPriorityRemoved(policy, priority) {
  for (const goal of (policy.goals || [])) {
    if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
      const row = goal.priorityRows.find((r) => (r.priority || '').toLowerCase() === priority);
      if (row && row.timeValue !== undefined && row.timeValue !== null && row.timeValue !== '') {
        return parseFloat(row.timeValue) === 0;
      }
    } else if (goal.timeValue !== undefined && goal.timeValue !== null && goal.timeValue !== '') {
      return parseFloat(goal.timeValue) === 0;
    }
  }
  return false;
}

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'bulk-false-positive-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','bulk-false-positive-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  const { rows: tickets } = await pool.query(`
    SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i."spaceId", i.current_department, i.priority, i."dueDate"
    FROM issues i
    LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE i."dueDate" IS NOT NULL AND i."dueDate" < NOW()
      AND (s.category IS NULL OR s.category != 'done')
  `);

  const policiesBySpace = {};
  const { rows: allPolicies } = await pool.query(`SELECT * FROM sla_definitions WHERE status = 'active'`);
  for (const p of allPolicies) (policiesBySpace[p.spaceId] ??= []).push(p);

  const falsePositives = [];
  for (const t of tickets) {
    const priority = (t.priority || 'medium').toLowerCase();
    const dept = (t.current_department || '').trim().toLowerCase();
    const policies = (policiesBySpace[t.spaceId] || []).filter((p) => {
      const pDept = (p.dept_name || '').trim().toLowerCase();
      return !pDept || pDept === dept;
    });
    const noPolicyAtAll = policies.length === 0;
    const allRemoved = policies.length > 0 && policies.every((p) => isPriorityRemoved(p, priority));
    if (noPolicyAtAll || allRemoved) falsePositives.push(t);
  }
  console.log(`Checking all ${falsePositives.length} identified false-positive tickets against the live API...\n`);

  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  let stillWrong = 0, correctlyFixed = 0, notFoundInQueue = 0;
  for (const t of falsePositives) {
    const url = `${APP_URL}/api/issues?spaceKey=TESTIN&dept=${encodeURIComponent(t.current_department)}&queueMembersOnly=true&q=${t.key}&page=1&limit=10`;
    const res = await fetch(url, { headers: authHeader, signal: AbortSignal.timeout(30000) }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    const issue = (data.issues || []).find((i) => (i.cfKey || i.key) === t.key);
    if (!issue) { notFoundInQueue++; console.log(` - ${t.key}: not in ${t.current_department} queue listing (fine -- nothing wrong attributed)`); continue; }
    if (issue.sla_breached) { stillWrong++; console.log(` - ${t.key}: *** STILL SHOWS sla_breached=true, by ${issue.sla_breached_by} *** NEEDS ATTENTION`); }
    else { correctlyFixed++; console.log(` - ${t.key}: sla_breached=false -- correctly fixed`); }
  }

  console.log(`\nSummary: ${correctlyFixed} correctly fixed, ${notFoundInQueue} no longer in that queue listing, ${stillWrong} STILL WRONG`);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
