// computeSLAInstancesPure (used to build the ticket detail page's own
// issue.sla array) DOES already fall back to jira_sla_breached for a
// resolved ticket with no other breach data -- so CF-29982 should show as
// breached there too, contradicting the user's report that it shows no
// SLA at all. Fetches the REAL live ticket detail response to see exactly
// what issue.sla actually contains, instead of continuing to reason from
// the source alone.
//
// Usage: node check-cf29982-live-sla.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'cf29982-sla-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','cf29982-sla-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return token;
}

async function main() {
  const token = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const res = await fetch(`${APP_URL}/api/issues/CF-29982`, { headers: authHeader });
  const data = await res.json();
  console.log(`Status: ${res.status}`);
  console.log(`issue.sla = ${JSON.stringify(data.sla, null, 2)}`);
  console.log(`\njira_sla_breached on the response: ${data.jira_sla_breached}`);
  console.log(`current_department: ${data.current_department}`);

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
