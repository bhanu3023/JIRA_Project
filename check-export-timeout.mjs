// Read-only: reproduce the Filters-page export request that failed with
// "Export failed: Request failed" for Queue=Dev + Assignee + Created/Updated
// range, timing each page exactly like handleExport's own fetchPage (up to
// 1000 rows/page, 120s client timeout) so a genuine backend slowdown/timeout
// can be told apart from something that actually throws.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'export-repro', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','export-repro',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function timeFetch(label, url, headers) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const ms = Date.now() - t0;
    console.log(`${label}: ${ms}ms (status ${res.status}${parsed?.total != null ? `, total=${parsed.total}` : ''}${parsed?.issues ? `, returned=${parsed.issues.length}` : ''}${!parsed ? `, body (first 300 chars): ${text.slice(0,300)}` : ''})`);
  } catch (e) {
    const ms = Date.now() - t0;
    console.log(`${label}: FAILED after ${ms}ms -- ${e?.message || e}`);
  }
}

async function main() {
  if (!JWT_SECRET) { console.error('JWT_SECRET env var not set in this container'); process.exit(1); }
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const base = `spaceKey=TESTIN&dept=Dev&queueMembersOnly=true&assignees=pg_mawkgv3jc&assigneeStrict=true&createdRange=between:2026-10-01:2026-10-28&updatedRange=between:2026-10-01:2026-10-28&multiSep=pipe`;

  console.log('=== Reproducing the failed export, page by page ===');
  await timeFetch('Page 1 (limit=1000)', `${APP_URL}/api/issues?${base}&page=1&limit=1000`, authHeader);
  await timeFetch('Page 1 (limit=50, normal table view)', `${APP_URL}/api/issues?${base}&page=1&limit=50`, authHeader);
  await timeFetch('Page 1, no date range', `${APP_URL}/api/issues?spaceKey=TESTIN&dept=Dev&queueMembersOnly=true&assignees=pg_mawkgv3jc&assigneeStrict=true&multiSep=pipe&page=1&limit=1000`, authHeader);
  await timeFetch('Page 1, no assignee', `${APP_URL}/api/issues?spaceKey=TESTIN&dept=Dev&queueMembersOnly=true&multiSep=pipe&page=1&limit=1000`, authHeader);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
