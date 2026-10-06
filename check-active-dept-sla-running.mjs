// Verifies the core per-department SLA pause/resume mechanism directly:
// for an ACTIVE (unresolved) ticket currently in department X, only
// X's own SLA should show isPaused=false (running); any OTHER
// department the ticket previously visited should show isPaused=true
// (frozen). Picks a few real active tickets across different current
// departments and checks their live SLA state. Read-only.
//
// Usage: node check-active-dept-sla-running.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'dept-sla-running-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'dept-sla-running-check', new Date(Date.now() + 3600 * 1000)]
  );

  // Find a few real active tickets that have dept_sla_log entries for
  // MULTIPLE departments (i.e. genuinely bounced around) and are
  // currently unresolved -- the most meaningful test case.
  const { rows: candidates } = await pool.query(`
    SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i.current_department
    FROM issues i
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE s.category != 'done'
      AND jsonb_array_length(COALESCE((SELECT jsonb_agg(k) FROM jsonb_object_keys(i.dept_sla_log) k), '[]'::jsonb)) >= 2
    LIMIT 5
  `);
  console.log(`Testing ${candidates.length} active, multi-department tickets...\n`);

  let allCorrect = true;
  for (const c of candidates) {
    const res = await fetch(`http://localhost:${PORT}/api/issues/${c.key}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => null);
    const slaList = data?.sla || data?.issue?.sla || [];
    console.log(`${c.key} (current_department=${c.current_department}):`);
    for (const s of slaList) {
      const shouldBeRunning = s.deptName?.toLowerCase() === c.current_department?.toLowerCase();
      const isRunning = !s.isPaused && !s.isCompleted;
      const correct = s.isCompleted || (isRunning === shouldBeRunning);
      if (!correct) allCorrect = false;
      console.log(`  [${s.deptName}] isPaused=${s.isPaused} isCompleted=${s.isCompleted} ${correct ? 'OK' : '<-- WRONG, expected isPaused=' + !shouldBeRunning}`);
    }
  }
  console.log(`\n${allCorrect ? 'ALL CORRECT' : 'FOUND MISMATCHES'}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
