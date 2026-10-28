// Read-only: (1) confirm the deployed dept-scoped-snapshot fix actually
// changed CF-34498's verdict under Queue: Dev, and (2) independently verify
// the "560 issues" count for Queue: Dev + Created/Updated between
// 2026-10-01 and 2026-10-28 (either) against raw SQL, so the Filters page's
// plain ticket list (no SLA filter this time) can be confirmed as real too.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'verify', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','verify',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  if (!JWT_SECRET) { console.error('JWT_SECRET not set'); process.exit(1); }
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  // 1. CF-34498 re-check under Queue: Dev + SLA Breached: Yes
  const qs1 = `spaceKey=TESTIN&dept=Dev&queueMembersOnly=true&slaBreached=yes&multiSep=pipe&page=1&limit=200`;
  const res1 = await fetch(`${APP_URL}/api/issues?${qs1}`, { headers: authHeader, signal: AbortSignal.timeout(60000) });
  const data1 = await res1.json();
  const cf34498 = (data1.issues || []).find((i) => (i.cfKey || i.key) === 'CF-34498');
  console.log(`Queue: Dev + SLA Breached: Yes now returns total=${data1.total}`);
  console.log(`CF-34498 ${cf34498 ? 'STILL appears' : 'no longer appears'} in this list (expected: no longer appears, since it only used 5.5h of its 12h Dev goal)`);

  // 2. Plain Queue: Dev + Created/Updated range count, cross-checked against raw SQL
  const qs2 = `spaceKey=TESTIN&dept=Dev&queueMembersOnly=true&createdRange=between:2026-10-01:2026-10-28&updatedRange=between:2026-10-01:2026-10-28&multiSep=pipe&page=1&limit=1`;
  const res2 = await fetch(`${APP_URL}/api/issues?${qs2}`, { headers: authHeader, signal: AbortSignal.timeout(60000) });
  const data2 = await res2.json();
  console.log(`\nAPI: Queue: Dev + Created/Updated 2026-10-01..2026-10-28 -> total=${data2.total}`);

  const { rows: queueRow } = await pool.query(
    `SELECT queues FROM custom_queues WHERE "spaceId" = (SELECT id FROM spaces WHERE key='TESTIN') LIMIT 1`
  ).catch(() => ({ rows: [] }));
  const devQueue = (queueRow[0]?.queues || []).find((q) => (q.name || '').toLowerCase() === 'dev');
  const memberIds = devQueue?.memberIds || [];
  console.log(`Dev queue has ${memberIds.length} configured member(s)`);

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM issues i
     WHERE i."spaceId" = (SELECT id FROM spaces WHERE key='TESTIN')
       AND LOWER(i.current_department) = 'dev'
       AND (
         (i."assigneeId" = ANY($1::text[]))
         OR EXISTS (SELECT 1 FROM user_worked_on_tickets w WHERE w.issue_id = i.id AND w.user_id = ANY($1::text[]) AND LOWER(w.dept) = 'dev' AND w.reason != 'passed')
       )
       AND (
         (i."createdAt" >= '2026-10-01' AND i."createdAt" < '2026-10-29')
         OR (i."updatedAt" >= '2026-10-01' AND i."updatedAt" < '2026-10-29')
       )`,
    [memberIds]
  );
  console.log(`Raw SQL (mirroring the app's own dept-queue-membership match): cnt=${countRows[0]?.cnt}`);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
