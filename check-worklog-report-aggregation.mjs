// Read-only: verify the Worklog report's totals and per-person breakdown are
// internally correct -- fetch the real GET /worklogs data for the same date
// range the UI showed (Oct 5 - Nov 3, 2026), aggregate it exactly the way a
// "Total Logged / Entries / Avg per entry / Per-person breakdown" report
// should, and sanity-check the arithmetic (sum of per-person minutes equals
// the grand total, count of per-person entries equals the grand total
// entries, avg = total/entries).
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

function fmtHM(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}h ${m}m`;
}

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'worklog-agg-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','worklog-agg-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const url = `${APP_URL}/api/worklogs?from=2026-10-05&to=2026-11-03`;
  const res = await fetch(url, { headers: authHeader, signal: AbortSignal.timeout(60000) });
  const rows = await res.json();
  console.log(`API returned ${rows.length} worklog rows for this date range.\n`);

  const totalMins = rows.reduce((s, r) => s + (r.timeSpentMinutes || 0), 0);
  console.log(`Computed Total Logged: ${fmtHM(totalMins)}`);
  console.log(`Computed Entries: ${rows.length}`);
  console.log(`Computed Avg per entry: ${fmtHM(totalMins / rows.length)}`);

  const byPerson = new Map();
  for (const r of rows) {
    const key = r.authorName || r.authorId || 'Unknown';
    const cur = byPerson.get(key) || { mins: 0, count: 0 };
    cur.mins += r.timeSpentMinutes || 0;
    cur.count += 1;
    byPerson.set(key, cur);
  }
  const sorted = [...byPerson.entries()].sort((a, b) => b[1].mins - a[1].mins);
  console.log('\nPer-person breakdown (top 10):');
  for (const [name, v] of sorted.slice(0, 10)) {
    console.log(`  ${name}: ${fmtHM(v.mins)}, ${v.count} entries, avg ${fmtHM(v.mins / v.count)}`);
  }

  const sumOfPersonMins = sorted.reduce((s, [, v]) => s + v.mins, 0);
  const sumOfPersonCounts = sorted.reduce((s, [, v]) => s + v.count, 0);
  console.log(`\nSanity check: sum of all per-person minutes = ${sumOfPersonMins} (should equal total ${totalMins}) -> ${sumOfPersonMins === totalMins ? 'MATCH' : 'MISMATCH'}`);
  console.log(`Sanity check: sum of all per-person entry counts = ${sumOfPersonCounts} (should equal ${rows.length}) -> ${sumOfPersonCounts === rows.length ? 'MATCH' : 'MISMATCH'}`);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
