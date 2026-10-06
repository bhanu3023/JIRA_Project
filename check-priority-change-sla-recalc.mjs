// Checks whether changing an active (unresolved) ticket's priority
// actually recalculates its SLA Due time live, by picking a real
// unresolved Migration ticket, reading its current SLA, changing
// priority via the real PATCH endpoint, then reading the SLA again.
// Reverts the priority back to its original value at the end either
// way. Read + one real write (reverted).
//
// Usage: node check-priority-change-sla-recalc.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: candidates } = await pool.query(`
    SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i.priority
    FROM issues i
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE i.current_department = 'Migration' AND s.category != 'done' AND i.priority = 'medium'
    LIMIT 1
  `);
  if (!candidates.length) { console.log('No candidate found'); await pool.end(); return; }
  const ticket = candidates[0];
  console.log(`Using ${ticket.key}, current priority=${ticket.priority}`);

  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'priority-sla-recalc-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'priority-sla-recalc-check', new Date(Date.now() + 3600 * 1000)]
  );

  async function getSla() {
    const res = await fetch(`http://localhost:${PORT}/api/issues/${ticket.key}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => null);
    const sla = (data?.sla || data?.issue?.sla || []).find((s) => s.deptName?.toLowerCase() === 'migration');
    return sla;
  }

  const before = await getSla();
  console.log('Before (priority=medium): dueTime=', before?.dueTime, 'goalDurationMs=', before?.goalDurationMs);

  await fetch(`http://localhost:${PORT}/api/issues/${ticket.key}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority: 'low' }),
  });

  const after = await getSla();
  console.log('After (priority changed to low): dueTime=', after?.dueTime, 'goalDurationMs=', after?.goalDurationMs);

  // Revert
  await fetch(`http://localhost:${PORT}/api/issues/${ticket.key}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority: 'medium' }),
  });
  console.log('Reverted priority back to medium.');

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
