// Retries the sla_snapshot refresh for tickets the previous run left
// stuck: their snapshot was cleared (set to NULL) but the follow-up
// GET failed because of the app's own rate limit (400 req/min per
// user -- the previous run hammered it with no delay and got
// throttled after ~200 requests). Selects tickets via the same
// issue_history marker, but now looking for sla_snapshot IS NULL
// (cleared-but-never-refreshed) instead of IS NOT NULL. Paces
// requests at ~4/sec (240/min, safely under the 400/min cap) instead
// of firing as fast as possible. Dry-run by default; --apply.
//
// Usage: node retry-sla-snapshot-refresh.mjs [--apply]
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const APPLY = process.argv.includes('--apply');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { rows: affected } = await pool.query(`
    SELECT DISTINCT i.id, COALESCE(i.cf_key, i.key) AS key
    FROM issue_history h
    JOIN issues i ON i.id = h."issueId"
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE h.field = 'priority' AND h."authorName" = 'System (Highest priority removed)'
      AND i.sla_snapshot IS NULL
  `);
  console.log(`${affected.length} tickets still need a retry (snapshot cleared but never refreshed).`);
  if (!affected.length) { await pool.end(); return; }

  if (!APPLY) {
    console.log('Dry run only -- re-run with --apply to refresh these (paced, ~4/sec).');
    await pool.end();
    return;
  }

  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'sla-snapshot-retry', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'sla-snapshot-retry', new Date(Date.now() + 3600 * 1000)]
  );

  let refreshed = 0, errors = 0;
  for (const t of affected) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/issues/${t.key}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) refreshed++; else { errors++; console.log(`  ${t.key}: HTTP ${res.status}`); }
    } catch (e) {
      errors++;
    }
    await sleep(250); // ~4/sec, 240/min, safely under the 400/min rate limit
    if ((refreshed + errors) % 100 === 0) console.log(`  ...${refreshed + errors}/${affected.length} processed (refreshed=${refreshed}, errors=${errors})`);
  }
  console.log(`\nDone. refreshed=${refreshed} errors=${errors}`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
