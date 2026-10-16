// Compares MBR vs Filters for EVERY person on the eng (Dev) team roster,
// for Sep 1-30 2026 -- to find every mismatch at once instead of one
// person at a time.
//
// Usage: node check-eng-team-sep-all-people.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const BASE = `http://localhost:${PORT}/api`;
const FROM = '2026-09-01';
const TO = '2026-09-30';
const DEPT = 'Dev';

async function main() {
  const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const admin = adminRows[0];
  const payload = { sub: admin.id, ip: '', ua: 'check-eng-sep', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'check-eng-sep', new Date(Date.now() + 3600 * 1000)]
  );
  const auth = { Authorization: `Bearer ${token}` };

  const mbrQs = new URLSearchParams({ team: 'eng', dateFrom: FROM, dateTo: TO });
  const mbrRes = await fetch(`${BASE}/reports/mbr-team?${mbrQs}`, { headers: auth });
  const mbrData = await mbrRes.json();
  const people = (mbrData.people || []).filter((p) => p.total > 0);
  console.log(`${people.length} people with tickets in MBR for Eng/Dev, ${FROM}..${TO}\n`);

  let matchCount = 0, mismatchCount = 0;
  for (const p of people) {
    const { rows: u } = await pool.query(`SELECT id FROM users WHERE email = $1`, [p.email]);
    if (!u.length) { console.log(`${p.name} <${p.email}>: no user row found, skipping Filters check`); continue; }
    const filtersQs = new URLSearchParams({
      spaceKey: 'TESTIN', dept: DEPT, queueMembersOnly: 'true',
      assignees: u[0].id, workedRange: `between:${FROM}:${TO}`, workedIncludeOpen: 'true', limit: '1',
    });
    const fRes = await fetch(`${BASE}/issues?${filtersQs}`, { headers: auth });
    const fData = fRes.ok ? await fRes.json() : { total: 'ERROR' };
    const match = fData.total === p.total;
    if (match) matchCount++; else mismatchCount++;
    console.log(`${match ? '  OK ' : '  !! '}${p.name.padEnd(28)} MBR=${p.total}  Filters=${fData.total}  ${match ? '' : `(diff ${fData.total - p.total >= 0 ? '+' : ''}${fData.total - p.total})`}`);
  }
  console.log(`\n${matchCount} match, ${mismatchCount} mismatch`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
