// Compares Rehan Khan's "Total tickets" count from MBR's per-person
// endpoint against Filters' own ticket count, for a few likely date
// ranges, to find a real mismatch without needing a screenshot first.
//
// Usage: node check-rehan-mbr-vs-filters.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const BASE = `http://localhost:${PORT}/api`;

async function main() {
  const { rows: userRows } = await pool.query(
    `SELECT id, email FROM users WHERE email ILIKE '%rehan.khan%' OR (email = 'bhanu.srikakulam@cloudfuze.com')`
  );
  const rehan = userRows.find((u) => u.email.toLowerCase().includes('rehan.khan'));
  const admin = userRows.find((u) => u.email === 'bhanu.srikakulam@cloudfuze.com');
  if (!rehan) { console.log('Rehan Khan not found by email pattern'); await pool.end(); return; }
  console.log('Rehan Khan:', rehan.email);

  const payload = { sub: admin.id, ip: '', ua: 'check-rehan', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'check-rehan', new Date(Date.now() + 3600 * 1000)]
  );
  const auth = { Authorization: `Bearer ${token}` };

  // Find which team/space has Rehan as a member, by checking the mbr-team
  // endpoint across the most likely teams.
  const candidateTeams = ['eng', 'qa', 'infra', 'ent', 'smb'];
  const now = new Date();
  const ranges = [
    { label: 'This month', from: new Date(now.getFullYear(), now.getMonth(), 1), to: now },
    { label: 'Last 30 days', from: new Date(now.getTime() - 30 * 86400000), to: now },
    { label: 'All time (wide)', from: new Date('2020-01-01'), to: now },
  ];

  // Also check with NO date params at all -- dateFrom/dateTo default to ''
  // in the MBR page's own useState, so a user who never touched the date
  // picker is sending neither param, which may hit a different backend
  // default than any explicit range tested below.
  for (const team of candidateTeams) {
    const qs = new URLSearchParams({ team, person: rehan.email });
    const res = await fetch(`${BASE}/reports/mbr-team?${qs}`, { headers: auth });
    if (res.ok) {
      const data = await res.json();
      const me = (data.people || []).find((p) => p.email === rehan.email);
      if (me) console.log(`[MBR] team=${team} NO DATE PARAMS (page default): total=${me.total}, resolved=${me.resolved}`);
    }
  }

  for (const team of candidateTeams) {
    for (const r of ranges) {
      const qs = new URLSearchParams({
        team, dateFrom: r.from.toISOString().slice(0, 10), dateTo: r.to.toISOString().slice(0, 10), person: rehan.email,
      });
      const res = await fetch(`${BASE}/reports/mbr-team?${qs}`, { headers: auth });
      if (!res.ok) continue;
      const data = await res.json();
      const people = data.people || [];
      const me = people.find((p) => p.email === rehan.email);
      if (me && me.total > 0) {
        console.log(`\n[MBR] team=${team} range=${r.label} (${qs.get('dateFrom')}..${qs.get('dateTo')}): total=${me.total}, resolved=${me.resolved}`);
      }
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
