// Broader version of verify-response-time-fallback-fix.mjs -- checks
// avgResponseTimeHours across ALL FIVE MBR teams (eng, qa, infra, ent, smb)
// for Aug 2026, not just Customer Engineering, to confirm the fix
// generalizes rather than only working for the one team already tested.
//
// Usage: node verify-response-time-all-teams.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';
const ADMIN_EMAIL = 'bhanu.srikakulam@cloudfuze.com';
const TEAMS = ['eng', 'qa', 'infra', 'ent', 'smb'];

async function main() {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [ADMIN_EMAIL]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'verify-response-time-all-teams', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','verify-response-time-all-teams',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  const authHeader = { Authorization: `Bearer ${token}` };

  let grandDash = 0, grandTotal = 0;
  for (const team of TEAMS) {
    const res = await fetch(`${APP_URL}/api/reports/mbr-team?team=${team}&dateFrom=2026-08-01&dateTo=2026-08-31`, { headers: authHeader });
    const data = await res.json();
    const people = (data.people || []).filter((p) => (p.total || 0) > 0);
    const dashes = people.filter((p) => p.avgResponseTimeHours === null);
    grandDash += dashes.length;
    grandTotal += people.length;
    console.log(`\n=== ${team} (${people.length} people with tickets) ===`);
    for (const p of dashes) console.log(`  DASH: ${p.name} (total=${p.total})`);
    console.log(`  ${dashes.length}/${people.length} still show a dash.`);
  }

  console.log(`\n\nGrand total: ${grandDash} out of ${grandTotal} people across all 5 teams still show a dash.`);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
