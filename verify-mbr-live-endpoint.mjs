// Hit the real, live /reports/mbr-team endpoint (team=migration and
// team=dev) with a real admin session, and check whether CF-33405 (one of
// the confirmed mismatch candidates: currently in Migration, Migration
// itself never breached, but Dev breached at 25.5h vs its own 8h goal)
// is now correctly excluded from Migration's breach count and correctly
// included in Dev's.
//
// Read-only (GET requests only).
//
// Usage: node verify-mbr-live-endpoint.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email, role FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  if (!user) { console.log('Admin user not found'); await pool.end(); return; }

  const payload = { sub: user.id, ip: '', ua: 'mbr-verify-script', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'mbr-verify-script', new Date(Date.now() + 3600 * 1000)]
  );

  // Wide date range to make sure CF-33405 (resolved 2026-09-28) falls inside it
  const dateFrom = '2026-01-01';
  const dateTo = '2026-12-31';

  // TEAM_DEPT mapping in jira-pg-api.ts: eng -> Dev, ent/smb -> Migration.
  for (const team of ['eng', 'ent', 'smb']) {
    const url = `http://localhost:${PORT}/api/reports/mbr-team?team=${team}&dateFrom=${dateFrom}&dateTo=${dateTo}&ticketFilter=resolved`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { console.log(`${team}: HTTP ${res.status}`, await res.text().catch(() => '')); continue; }
    const data = await res.json();
    const ticket = (data.tickets || []).find((t) => (t.cfKey || t.key) === 'CF-33405');
    console.log(`\n[team=${team}] CF-33405 found in this team's ticket list: ${!!ticket}`);
    if (ticket) console.log(`  slaBreached field: ${JSON.stringify(ticket.slaBreached ?? ticket.breached ?? '(field not present, see full object below)')}`);
    if (ticket) console.log('  Full ticket object:', JSON.stringify(ticket));
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
