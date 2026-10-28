// Read-only: verify Filters' Queue: Migration (Created+Resolved date,
// Oct 1-28 2026 -> screenshot shows 498) against MBR's ENT+SMB sum for the
// identical range (screenshot shows ENT alone = 228).
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'migration-oct-verify', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','migration-oct-verify',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  if (!JWT_SECRET) { console.error('JWT_SECRET not set'); process.exit(1); }
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const DATE_FROM = '2026-10-01', DATE_TO = '2026-10-28';

  const filtersUrl = `${APP_URL}/api/issues?spaceKey=TESTIN&dept=Migration&queueMembersOnly=true&createdRange=between:${DATE_FROM}:${DATE_TO}&resolvedRange=between:${DATE_FROM}:${DATE_TO}&multiSep=pipe&page=1&limit=2000`;
  const filtersRes = await fetch(filtersUrl, { headers: authHeader, signal: AbortSignal.timeout(60000) });
  const filtersData = await filtersRes.json();
  const filtersKeys = new Set((filtersData.issues || []).map((i) => i.cfKey || i.key));
  console.log(`Filters: Queue: Migration total=${filtersData.total}`);

  const [ent, smb] = await Promise.all([
    fetch(`${APP_URL}/api/reports/mbr-team?team=ent&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`, { headers: authHeader, signal: AbortSignal.timeout(120000) }).then(r => r.json()),
    fetch(`${APP_URL}/api/reports/mbr-team?team=smb&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`, { headers: authHeader, signal: AbortSignal.timeout(120000) }).then(r => r.json()),
  ]);
  const entKeys = new Set((ent.tickets || []).map((t) => t.key));
  const smbKeys = new Set((smb.tickets || []).map((t) => t.key));
  console.log(`MBR: ENT total=${ent.summary?.total}, SMB total=${smb.summary?.total}, sum=${(ent.summary?.total||0)+(smb.summary?.total||0)}`);

  const overlap = [...entKeys].filter((k) => smbKeys.has(k));
  console.log(`ENT/SMB overlap (counted on both): ${overlap.length}`);

  const mbrUnion = new Set([...entKeys, ...smbKeys]);
  const inFiltersNotMbr = [...filtersKeys].filter((k) => !mbrUnion.has(k));
  const inMbrNotFilters = [...mbrUnion].filter((k) => !filtersKeys.has(k));
  console.log(`In Filters but not in ENT+SMB union: ${inFiltersNotMbr.length}`);
  console.log(`In ENT+SMB union but not in Filters: ${inMbrNotFilters.length}`);
  if (inFiltersNotMbr.length) console.log('  ' + inFiltersNotMbr.slice(0, 20).join(', '));
  if (inMbrNotFilters.length) console.log('  ' + inMbrNotFilters.slice(0, 20).join(', '));

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
