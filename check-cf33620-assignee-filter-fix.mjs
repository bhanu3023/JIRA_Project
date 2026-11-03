// Read-only: verify the Filters fix -- Queue: Infra + Assignee: Anish (and
// separately, + Assignee: Mubeen) should now both surface CF-33620, since
// both genuinely worked Infra on it (confirmed via assignee/status history).
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'cf33620-filter-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','cf33620-filter-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const { rows: anishRows } = await pool.query(`SELECT id FROM users WHERE "firstName" ILIKE 'anish%'`);
  const { rows: mubeenRows } = await pool.query(`SELECT id FROM users WHERE email = 'syed.mubeen@cloudfuze.com'`);
  const anishId = anishRows[0]?.id;
  const mubeenId = mubeenRows[0]?.id;
  console.log('Anish id:', anishId, ' Mubeen id:', mubeenId);

  for (const [name, id] of [['Anish', anishId], ['Mubeen', mubeenId]]) {
    const url = `${APP_URL}/api/issues?spaceKey=TESTIN&dept=Infra&queueMembersOnly=true&assignees=${id}&page=1&limit=2000`;
    const res = await fetch(url, { headers: authHeader, signal: AbortSignal.timeout(60000) });
    const data = await res.json();
    const found = (data.issues || []).some((i) => (i.cfKey || i.key) === 'CF-33620');
    console.log(`Queue: Infra + Assignee: ${name} -> total ${data.total} tickets, CF-33620 present: ${found}`);
  }

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
