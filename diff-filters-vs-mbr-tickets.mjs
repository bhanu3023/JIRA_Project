// For one person, fetches the real ticket KEY LISTS from both the live
// Filters (/issues) and MBR (/reports/mbr-team) endpoints for the same
// Queue:Dev + Created/Updated Aug 2026 scope, and diffs them -- to find
// exactly which tickets are causing a count mismatch, not just the size of
// the gap. Reuses the same real-session approach as
// check-ce-roster-filters-vs-mbr.mjs.
//
// Usage: node diff-filters-vs-mbr-tickets.mjs <email>

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';
const EMAIL = process.argv[2];

if (!EMAIL) {
  console.error('Usage: node diff-filters-vs-mbr-tickets.mjs <email>');
  process.exit(1);
}

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'diff-script', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','diff-script',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return token;
}

async function main() {
  const token = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const filtersParams = new URLSearchParams({
    spaceKey: 'TESTIN', dept: 'Dev', queueMembersOnly: 'true', assignees: EMAIL,
    createdRange: 'between:2026-08-01:2026-08-31', updatedRange: 'between:2026-08-01:2026-08-31',
    page: '1', limit: '200',
  });
  const filtersRes = await fetch(`${APP_URL}/api/issues?${filtersParams}`, { headers: authHeader });
  const filtersData = await filtersRes.json();
  const filtersKeys = new Set((filtersData.issues || []).map(i => i.cfKey || i.key));

  const mbrParams = new URLSearchParams({ team: 'eng', dateFrom: '2026-08-01', dateTo: '2026-08-31', person: EMAIL });
  const mbrRes = await fetch(`${APP_URL}/api/reports/mbr-team?${mbrParams}`, { headers: authHeader });
  const mbrData = await mbrRes.json();
  const mbrKeys = new Set((mbrData.tickets || []).map(t => t.key));

  console.log(`${EMAIL}: Filters=${filtersKeys.size} tickets, MBR=${mbrKeys.size} tickets\n`);

  const onlyInFilters = [...filtersKeys].filter(k => !mbrKeys.has(k));
  const onlyInMbr = [...mbrKeys].filter(k => !filtersKeys.has(k));

  console.log(`In Filters but NOT in MBR (${onlyInFilters.length}): ${onlyInFilters.join(', ') || '(none)'}`);
  console.log(`In MBR but NOT in Filters (${onlyInMbr.length}): ${onlyInMbr.join(', ') || '(none)'}`);

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
