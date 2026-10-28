// Read-only: broad confidence check across EVERY MBR team tab (eng/qa/infra,
// plus Migration ENT+SMB summed against Filters' Migration total) and a
// DIFFERENT, wider date range than previously tested, comparing exact
// ticket-key sets (not just totals) wherever a clean 1:1 team<->department
// mapping exists.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'broad-verify', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','broad-verify',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function compareOneToOne(authHeader, team, dept, dateFrom, dateTo) {
  const mbrUrl = `${APP_URL}/api/reports/mbr-team?team=${team}&dateFrom=${dateFrom}&dateTo=${dateTo}`;
  const mbrRes = await fetch(mbrUrl, { headers: authHeader, signal: AbortSignal.timeout(120000) });
  const mbrData = await mbrRes.json();
  const mbrKeys = new Set((mbrData.tickets || []).map((t) => t.key));

  const filtersUrl = `${APP_URL}/api/issues?spaceKey=TESTIN&dept=${dept}&queueMembersOnly=true&createdRange=between:${dateFrom}:${dateTo}&resolvedRange=between:${dateFrom}:${dateTo}&multiSep=pipe&page=1&limit=2000`;
  const filtersRes = await fetch(filtersUrl, { headers: authHeader, signal: AbortSignal.timeout(60000) });
  const filtersData = await filtersRes.json();
  const filtersKeys = new Set((filtersData.issues || []).map((i) => i.cfKey || i.key));

  const inFiltersNotMbr = [...filtersKeys].filter((k) => !mbrKeys.has(k));
  const inMbrNotFilters = [...mbrKeys].filter((k) => !filtersKeys.has(k));
  console.log(`${dept} (${dateFrom}..${dateTo}): MBR total=${mbrData.summary?.total} Filters total=${filtersData.total} | diff: +${inFiltersNotMbr.length} in Filters only, +${inMbrNotFilters.length} in MBR only`);
  if (inFiltersNotMbr.length) console.log(`  In Filters not MBR: ${inFiltersNotMbr.slice(0, 10).join(', ')}`);
  if (inMbrNotFilters.length) console.log(`  In MBR not Filters: ${inMbrNotFilters.slice(0, 10).join(', ')}`);
}

async function main() {
  if (!JWT_SECRET) { console.error('JWT_SECRET not set'); process.exit(1); }
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  console.log('=== Wider range: 2026-08-01 to 2026-10-28 ===');
  await compareOneToOne(authHeader, 'eng', 'Dev', '2026-08-01', '2026-10-28');
  await compareOneToOne(authHeader, 'qa', 'QA', '2026-08-01', '2026-10-28');
  await compareOneToOne(authHeader, 'infra', 'Infra', '2026-08-01', '2026-10-28');

  console.log('\n=== Migration ENT+SMB sum vs Filters Migration total ===');
  const [ent, smb, migFilters] = await Promise.all([
    fetch(`${APP_URL}/api/reports/mbr-team?team=ent&dateFrom=2026-08-01&dateTo=2026-10-28`, { headers: authHeader, signal: AbortSignal.timeout(120000) }).then(r => r.json()),
    fetch(`${APP_URL}/api/reports/mbr-team?team=smb&dateFrom=2026-08-01&dateTo=2026-10-28`, { headers: authHeader, signal: AbortSignal.timeout(120000) }).then(r => r.json()),
    fetch(`${APP_URL}/api/issues?spaceKey=TESTIN&dept=Migration&queueMembersOnly=true&createdRange=between:2026-08-01:2026-10-28&resolvedRange=between:2026-08-01:2026-10-28&multiSep=pipe&page=1&limit=1`, { headers: authHeader, signal: AbortSignal.timeout(60000) }).then(r => r.json()),
  ]);
  const entTotal = ent.summary?.total || 0, smbTotal = smb.summary?.total || 0;
  console.log(`ENT=${entTotal} + SMB=${smbTotal} = ${entTotal + smbTotal} vs Filters Migration total=${migFilters.total}`);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
