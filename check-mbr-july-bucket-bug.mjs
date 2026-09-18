// MBR Customer Engineering tab, Aug 1-31 2026 filter, shows 13 tickets
// bucketed under "Jul 2026" in Monthly Summary -- shouldn't be possible if
// createdAt-or-updatedAt-in-range is the only thing that can match a
// ticket into the result set, since monthLabelFor falls back to whichever
// of those two is actually in range. Calls the real live endpoint and
// pulls the raw createdAt/updatedAt for every ticket to find out which
// ones are landing in July and why.
//
// Usage: node check-mbr-july-bucket-bug.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'mbr-july-bucket-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','mbr-july-bucket-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return token;
}

async function main() {
  const token = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const params = new URLSearchParams({ team: 'eng', dateFrom: '2026-08-01', dateTo: '2026-08-31' });
  const res = await fetch(`${APP_URL}/api/reports/mbr-team?${params}`, { headers: authHeader });
  const data = await res.json();
  console.log(`Monthly summary from live endpoint: ${JSON.stringify(data.monthly)}`);
  console.log(`Total tickets in response: ${data.tickets?.length}`);

  // Find whichever tickets have a key -- pull their real createdAt/updatedAt
  // directly from the DB so we can see exactly why each one might land in July.
  const keys = (data.tickets || []).map((t) => t.key).filter(Boolean);
  if (keys.length) {
    const { rows } = await pool.query(
      `SELECT COALESCE(cf_key, key) AS key, "createdAt", "updatedAt" FROM issues WHERE cf_key = ANY($1::text[]) OR key = ANY($1::text[])`,
      [keys]
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    console.log('\nPer-ticket createdAt/updatedAt vs Aug 1-31 range:');
    let julyCount = 0;
    for (const key of keys) {
      const r = byKey[key];
      if (!r) { console.log(`  ${key}: not found in DB`); continue; }
      const created = r.createdAt.toISOString();
      const updated = r.updatedAt.toISOString();
      // IST-shift to see which calendar month each field really falls in
      const istMonth = (d) => {
        const shifted = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
        return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
      };
      const createdIstMonth = istMonth(r.createdAt);
      const updatedIstMonth = istMonth(r.updatedAt);
      const looksJuly = createdIstMonth === '2026-07' && updatedIstMonth === '2026-07';
      if (looksJuly) {
        julyCount++;
        console.log(`  ${key}: createdAt=${created} (IST month ${createdIstMonth})  updatedAt=${updated} (IST month ${updatedIstMonth})  <-- BOTH in July`);
      }
    }
    console.log(`\nTickets where BOTH createdAt and updatedAt are in July (shouldn't have matched an Aug-only filter at all): ${julyCount}`);
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
