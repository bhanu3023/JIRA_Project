// Generalized version of check-ce-roster-filters-vs-mbr.mjs -- for a given
// MBR team code + Filters Queue name + roster of real emails, calls the
// ACTUAL live /issues (Filters) and MBR team-tab endpoints for Created AND
// Updated Aug 1-31, and compares their per-person counts directly, using
// the real running code (see the CE version for why reconstruction is
// unsafe here).
//
// Usage: node check-roster-filters-vs-mbr.mjs <mbrTeam> <queueDept> <email1,email2,...>
// Example (Infra): node check-roster-filters-vs-mbr.mjs infra Infra gururaj.bhimrao@cloudfuze.com,hymavathi@cloudfuze.com,pavan@cloudfuze.com,bala.raviteja@cloudfuze.com

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';

const [, , MBR_TEAM, QUEUE_DEPT, ROSTER_CSV] = process.argv;
if (!MBR_TEAM || !QUEUE_DEPT || !ROSTER_CSV) {
  console.error('Usage: node check-roster-filters-vs-mbr.mjs <mbrTeam> <queueDept> <email1,email2,...>');
  process.exit(1);
}
const ROSTER = ROSTER_CSV.split(',').map(s => s.trim()).filter(Boolean);

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  if (!rows.length) throw new Error(`Admin user ${adminEmail} not found`);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'check-roster-script', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','check-roster-script',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return token;
}

async function main() {
  console.log('Creating a real, temporary admin session token...');
  const token = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  console.log(`\nChecking ${ROSTER.length} roster member(s), Queue:${QUEUE_DEPT} / MBR team:${MBR_TEAM}, Created+Updated Aug 2026...\n`);
  console.log('NAME'.padEnd(30) + 'FILTERS'.padEnd(10) + 'MBR TOTAL'.padEnd(12) + 'MATCH?');

  let filtersSum = 0, mbrSum = 0;
  for (const email of ROSTER) {
    const filtersParams = new URLSearchParams({
      spaceKey: 'TESTIN', dept: QUEUE_DEPT, queueMembersOnly: 'true', assignees: email,
      createdRange: 'between:2026-08-01:2026-08-31', updatedRange: 'between:2026-08-01:2026-08-31',
      page: '1', limit: '1',
    });
    const filtersRes = await fetch(`${APP_URL}/api/issues?${filtersParams}`, { headers: authHeader });
    const filtersData = await filtersRes.json().catch(() => ({}));
    const filtersCount = filtersRes.ok ? filtersData.total : `ERR ${filtersRes.status}`;
    if (typeof filtersCount === 'number') filtersSum += filtersCount;

    const mbrParams = new URLSearchParams({ team: MBR_TEAM, dateFrom: '2026-08-01', dateTo: '2026-08-31', person: email });
    const mbrRes = await fetch(`${APP_URL}/api/reports/mbr-team?${mbrParams}`, { headers: authHeader });
    const mbrData = await mbrRes.json().catch(() => ({}));
    const mbrCount = mbrRes.ok ? (mbrData.summary?.total ?? 'n/a') : `ERR ${mbrRes.status}`;
    if (typeof mbrCount === 'number') mbrSum += mbrCount;

    const match = filtersCount === mbrCount ? 'YES' : 'NO';
    console.log(email.padEnd(30) + String(filtersCount).padEnd(10) + String(mbrCount).padEnd(12) + match);
  }
  console.log(`\nSum across roster: Filters=${filtersSum}, MBR=${mbrSum}  (each person's own total already double-counts a ticket credited to more than one roster member, same as MBR's own Total Tickets column does -- this sum is not the same thing as the queue-wide unique-ticket count)`);

  console.log('\nRevoking the temporary session...');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
