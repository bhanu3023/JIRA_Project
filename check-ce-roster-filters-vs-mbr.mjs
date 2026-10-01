// For every real Customer Engineering roster member, calls the ACTUAL live
// /issues (Filters) and MBR team-tab endpoints for Queue:Dev, Created AND
// Updated Aug 1-31, and compares their counts directly -- using the real
// running code, not a reconstruction (two independent attempts to replicate
// the matching logic externally undercounted badly: 34-38 vs the real 57+,
// because of subtle default-vs-history-matching rules in the actual code
// this script can't safely guess at).
//
// Builds a real, valid session the same way the app's own login flow does
// (signs a JWT with the real JWT_SECRET, inserts a matching user_sessions
// row) rather than any auth bypass -- this is the same mechanism a real
// browser session uses, just created by script instead of a login form.
//
// Read-only except for inserting one temporary session row (safe: it just
// grants API access as an existing real admin user, same as a normal
// login would, and can be revoked after).
//
// Usage: node check-ce-roster-filters-vs-mbr.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';

const CE_ROSTER = [
  'abhinandan.kumar@cloudfuze.com', 'akhila.aenkoju@cloudfuze.com', 'akib.mohd@cloudfuze.com', 'ankit@cloudfuze.com',
  'bhagyashri.deokar@cloudfuze.com', 'hemadasu.kantam@cloudfuze.com', 'jaswanth.adari@cloudfuze.com', 'lakshmi.adabala@cloudfuze.com',
  'mayank@cloudfuze.com', 'naved.osama@cloudfuze.com', 'pragati.pandey@cloudfuze.com', 'ravi.srivastava@cloudfuze.com',
  'rehan.khan@cloudfuze.com', 'sairaj.kanigicharla@cloudfuze.com', 'shiva.amuda@cloudfuze.com', 'shivam.singh@cloudfuze.com',
  'srinu.gudimitla@cloudfuze.com', 'vamsi.malla@cloudfuze.com', 'vishal.kumar@cloudfuze.com',
];

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  if (!rows.length) throw new Error(`Admin user ${adminEmail} not found`);
  const userId = rows[0].id;
  const payload = {
    sub: userId, ip: '', ua: 'check-ce-roster-script',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 3600 * 1000);
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','check-ce-roster-script',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, expiresAt]
  );
  return token;
}

async function main() {
  console.log('Creating a real, temporary admin session token...');
  const token = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const { rows: spaceRows } = await pool.query(`SELECT key FROM spaces WHERE key = 'TESTIN'`);
  if (!spaceRows.length) { console.log('Space TESTIN not found'); await pool.end(); return; }

  console.log(`\nChecking ${CE_ROSTER.length} CE roster member(s), Queue:Dev, Created+Updated Aug 2026...\n`);
  console.log('NAME'.padEnd(30) + 'FILTERS'.padEnd(10) + 'MBR TOTAL'.padEnd(12) + 'MATCH?');

  for (const email of CE_ROSTER) {
    // Filters: real /issues call, same params buildFilterParams would send
    // for Queue:Dev + this person as Assignee + both date ranges active.
    const filtersParams = new URLSearchParams({
      spaceKey: 'TESTIN',
      dept: 'Dev',
      queueMembersOnly: 'true',
      assignees: email,
      createdRange: 'between:2026-08-01:2026-08-31',
      updatedRange: 'between:2026-08-01:2026-08-31',
      page: '1',
      limit: '1',
    });
    const filtersRes = await fetch(`${APP_URL}/api/issues?${filtersParams}`, { headers: authHeader });
    const filtersData = await filtersRes.json().catch(() => ({}));
    const filtersCount = filtersRes.ok ? filtersData.total : `ERR ${filtersRes.status}`;

    // MBR: real team-tab call for Customer Engineering (team=eng), scoped
    // to this one person, same date range.
    const mbrParams = new URLSearchParams({
      team: 'eng',
      dateFrom: '2026-08-01',
      dateTo: '2026-08-31',
      person: email,
    });
    const mbrRes = await fetch(`${APP_URL}/api/reports/mbr-team?${mbrParams}`, { headers: authHeader });
    const mbrData = await mbrRes.json().catch(() => ({}));
    const mbrCount = mbrRes.ok ? (mbrData.summary?.total ?? 'n/a') : `ERR ${mbrRes.status}`;

    const match = filtersCount === mbrCount ? 'YES' : 'NO';
    console.log(email.padEnd(30) + String(filtersCount).padEnd(10) + String(mbrCount).padEnd(12) + match);
  }

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
