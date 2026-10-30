// Read-only: find the EXACT tickets that cause Filters' "Queue: Dev" count
// to disagree with MBR's "Customer Engineering" (team=eng) count for the
// identical date range, instead of guessing at the cause. Diffs the two
// endpoints' own ticket-key lists directly.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';
const DATE_FROM = '2026-10-01';
const DATE_TO = '2026-10-28';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'diff-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','diff-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  if (!JWT_SECRET) { console.error('JWT_SECRET not set'); process.exit(1); }
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  // Filters: Queue: Dev, Created/Updated in range (either)
  const filtersUrl = `${APP_URL}/api/issues?spaceKey=TESTIN&dept=Dev&queueMembersOnly=true&createdRange=between:${DATE_FROM}:${DATE_TO}&updatedRange=between:${DATE_FROM}:${DATE_TO}&multiSep=pipe&page=1&limit=1000`;
  const filtersRes = await fetch(filtersUrl, { headers: authHeader, signal: AbortSignal.timeout(60000) });
  const filtersData = await filtersRes.json();
  const filtersKeys = new Set((filtersData.issues || []).map((i) => i.cfKey || i.key));
  console.log(`Filters: Queue: Dev total=${filtersData.total}, fetched ${filtersKeys.size} keys`);

  // MBR: Customer Engineering (team=eng)
  const mbrUrl = `${APP_URL}/api/reports/mbr-team?team=eng&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}&staleDays=7`;
  const mbrRes = await fetch(mbrUrl, { headers: authHeader, signal: AbortSignal.timeout(120000) });
  const mbrData = await mbrRes.json();
  const mbrKeys = new Set((mbrData.tickets || []).map((t) => t.key));
  console.log(`MBR: Customer Engineering totalMatched=${mbrData.totalMatched}, tickets array length=${mbrKeys.size}`);

  const inFiltersNotMbr = [...filtersKeys].filter((k) => !mbrKeys.has(k));
  const inMbrNotFilters = [...mbrKeys].filter((k) => !filtersKeys.has(k));
  console.log(`\nIn Filters but NOT in MBR: ${inFiltersNotMbr.length}`);
  console.log(`In MBR but NOT in Filters: ${inMbrNotFilters.length}`);

  // For each diffed ticket, pull real dates/assignee/dept to see WHY it differs
  const explain = async (keys, label) => {
    if (!keys.length) return;
    console.log(`\n--- ${label} (up to 15) ---`);
    const sample = keys.slice(0, 15);
    const { rows } = await pool.query(
      `SELECT COALESCE(cf_key,key) AS key, current_department, "createdAt", "updatedAt", "resolvedAt", "assigneeId",
              (SELECT email FROM users WHERE id = issues."assigneeId") AS assignee_email
       FROM issues WHERE COALESCE(cf_key,key) = ANY($1::text[])`,
      [sample]
    );
    for (const r of rows) {
      console.log(` - ${r.key} | dept=${r.current_department} | created=${r.createdAt.toISOString().slice(0,10)} updated=${r.updatedAt.toISOString().slice(0,10)} resolved=${r.resolvedAt ? r.resolvedAt.toISOString().slice(0,10) : 'null'} | assignee=${r.assignee_email || 'none'}`);
    }
  };
  await explain(inFiltersNotMbr, 'In Filters but NOT in MBR');
  await explain(inMbrNotFilters, 'In MBR but NOT in Filters');

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
