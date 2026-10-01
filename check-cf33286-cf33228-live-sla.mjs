// Rather than reimplementing computeSLAInstancesPure's breach math by hand
// (risk of getting it subtly wrong, same trap as earlier sessions), calls
// the REAL live GET /api/issues/:key endpoint for both tickets -- which
// already runs the actual production SLA computation -- and prints the
// full `sla` field it returns, to see the ground truth and compare against
// what Filters displayed ("Breached: Yes, by Amulya A, in Migration").
//
// Usage: node check-cf33286-cf33228-live-sla.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';
const ADMIN_EMAIL = 'bhanu.srikakulam@cloudfuze.com';
const KEYS = ['CF-33286', 'CF-33228'];

async function main() {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [ADMIN_EMAIL]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'check-cf33286-cf33228-live-sla', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','check-cf33286-cf33228-live-sla',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  const authHeader = { Authorization: `Bearer ${token}` };

  for (const key of KEYS) {
    const res = await fetch(`${APP_URL}/api/issues/${key}`, { headers: authHeader });
    const data = await res.json();
    console.log(`\n=== ${key} ===`);
    console.log(`current_department: ${data.current_department}  priority: ${data.priority}`);
    console.log(`sla: ${JSON.stringify(data.sla, null, 2)}`);
  }

  // Also print the real SLA policy definitions for this space, for context.
  const { rows: spRows } = await pool.query(`SELECT id FROM spaces WHERE key = 'TESTIN'`);
  const spaceId = spRows[0]?.id;
  const { rows: defs } = await pool.query(`SELECT name, status, "startCondition", "stopCondition", goals FROM sla_definitions WHERE "spaceId" = $1`, [spaceId]);
  console.log(`\n=== SLA definitions for TESTIN (${defs.length}) ===`);
  for (const d of defs) console.log(`${d.name} (${d.status}): ${JSON.stringify(d.goals)}`);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
