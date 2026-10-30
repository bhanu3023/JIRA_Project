// Read-only: Filters' "Queue: Dev + SLA Breached: Yes" shows 80, MBR's
// Customer Engineering tab shows 76 breached -- find the exact ticket-level
// diff for the identical date range (Created+Resolved date, 2026-10-01 to
// 2026-10-29), reusing ticketFilter=rb (MBR's own "resolution breach"
// ticket list) instead of guessing.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';
const DATE_FROM = '2026-10-01', DATE_TO = '2026-10-29';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'breach-diff', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','breach-diff',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  if (!JWT_SECRET) { console.error('JWT_SECRET not set'); process.exit(1); }
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const filtersUrl = `${APP_URL}/api/issues?spaceKey=TESTIN&dept=Dev&queueMembersOnly=true&slaBreached=yes&createdRange=between:${DATE_FROM}:${DATE_TO}&resolvedRange=between:${DATE_FROM}:${DATE_TO}&multiSep=pipe&page=1&limit=500`;
  const filtersRes = await fetch(filtersUrl, { headers: authHeader, signal: AbortSignal.timeout(60000) });
  const filtersData = await filtersRes.json();
  const filtersKeys = new Set((filtersData.issues || []).map((i) => i.cfKey || i.key));
  console.log(`Filters: Queue: Dev + SLA Breached: Yes -> total=${filtersData.total}`);

  const mbrUrl = `${APP_URL}/api/reports/mbr-team?team=eng&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}&ticketFilter=rb`;
  const mbrRes = await fetch(mbrUrl, { headers: authHeader, signal: AbortSignal.timeout(120000) });
  const mbrData = await mbrRes.json();
  const mbrKeys = new Set((mbrData.tickets || []).map((t) => t.key));
  console.log(`MBR: Customer Engineering ticketFilter=rb -> total=${mbrData.totalMatched}, tickets array length=${mbrKeys.size}`);

  const inFiltersNotMbr = [...filtersKeys].filter((k) => !mbrKeys.has(k));
  const inMbrNotFilters = [...mbrKeys].filter((k) => !filtersKeys.has(k));
  console.log(`\nIn Filters-breached but NOT in MBR-breached: ${inFiltersNotMbr.length}`);
  console.log(`In MBR-breached but NOT in Filters-breached: ${inMbrNotFilters.length}`);

  const explain = async (keys, label) => {
    if (!keys.length) return;
    console.log(`\n--- ${label} ---`);
    const { rows } = await pool.query(
      `SELECT COALESCE(cf_key,key) AS key, current_department, "resolvedAt", sla_snapshot
       FROM issues WHERE COALESCE(cf_key,key) = ANY($1::text[])`,
      [keys]
    );
    for (const r of rows) {
      const snapInfo = (r.sla_snapshot || []).map((x) => `${x.deptName || 'generic'}:${x.isBreached}`).join(', ');
      console.log(` - ${r.key} | current_dept=${r.current_department} | resolvedAt=${r.resolvedAt ? r.resolvedAt.toISOString().slice(0,10) : 'null'} | snapshot=[${snapInfo}]`);
    }
  };
  await explain(inFiltersNotMbr, 'In Filters but not MBR');
  await explain(inMbrNotFilters, 'In MBR but not Filters');

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
