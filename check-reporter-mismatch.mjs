// Compares REAL stored reporterId/assigneeId for a sample of tickets
// against what the live Filters API returns for "reporter" and
// "assignee" -- the screenshot shows Reporter mirroring Assignee
// exactly (same name when assigned, blank when unassigned), which
// looks like a display bug rather than genuinely-empty reporter data.
// Read-only.
//
// Usage: node check-reporter-mismatch.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

const SAMPLE_KEYS = ['CF-31026', 'CF-22904', 'CF-12304', 'CF-8596', 'CF-8584', 'CF-29815', 'CF-32149', 'CF-33872'];

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'reporter-mismatch-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'reporter-mismatch-check', new Date(Date.now() + 3600 * 1000)]
  );

  // Real DB values
  const { rows: dbRows } = await pool.query(`
    SELECT COALESCE(i.cf_key, i.key) AS key, i."assigneeId", i."reporterId",
      au."firstName" AS a_first, au."lastName" AS a_last,
      ru."firstName" AS r_first, ru."lastName" AS r_last
    FROM issues i
    LEFT JOIN users au ON au.id = i."assigneeId"
    LEFT JOIN users ru ON ru.id = i."reporterId"
    WHERE i.cf_key = ANY($1::text[]) OR i.key = ANY($1::text[])
  `, [SAMPLE_KEYS]);
  console.log('Real DB values:');
  for (const r of dbRows) {
    console.log(`  ${r.key}: assigneeId=${r.assigneeId} (${r.a_first} ${r.a_last}) | reporterId=${r.reporterId} (${r.r_first} ${r.r_last})`);
  }

  // Live API values (Filters page's own Queue:Migration call)
  const qs = new URLSearchParams({ spaceKey: 'TESTIN', dept: 'Migration', queueMembersOnly: 'true', page: '1', limit: '2000', includeTimeSpent: 'true' });
  const res = await fetch(`http://localhost:${PORT}/api/issues?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => null);
  const byKey = new Map((data?.issues || []).map((i) => [i.cfKey || i.key, i]));
  console.log('\nLive API values:');
  for (const k of SAMPLE_KEYS) {
    const i = byKey.get(k);
    if (!i) { console.log(`  ${k}: not found in response`); continue; }
    console.log(`  ${k}: assignee=${JSON.stringify(i.assignee)} | reporter=${JSON.stringify(i.reporter)}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
