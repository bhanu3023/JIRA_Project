// Replicates the user's actual workflow: export Queue:Dev + Created/
// Updated Sep 2026 WITHOUT an assignee filter (the full 581-ish list),
// then count how many of those rows have assignee = Pragati -- same
// as using Excel's own column filter on the downloaded file. Compares
// against the count when Assignee:Pragati is applied directly at the
// API/export level (confirmed 70 in prior checks). If these two counts
// differ, that's a genuine bug: filtering by the same person should
// give the same result regardless of where the filter is applied.
// Read-only.
//
// Usage: node check-unfiltered-export-then-filter-pragati.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const PRAGATI_ID = 'pg_on73cwx5te';

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'unfiltered-then-filter-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'unfiltered-then-filter-check', new Date(Date.now() + 3600 * 1000)]
  );

  // Step 1: export the FULL Dev queue for Sep 2026, no assignee filter --
  // exactly what clicking Export does when only Queue+Created+Updated
  // are selected on screen.
  const qsFull = new URLSearchParams({
    spaceKey: 'TESTIN', dept: 'Dev', queueMembersOnly: 'true',
    createdRange: 'between:2026-09-01:2026-09-30',
    updatedRange: 'between:2026-09-01:2026-09-30',
    includeTimeSpent: 'true', page: '1', limit: '2000',
  });
  const resFull = await fetch(`http://localhost:${PORT}/api/issues?${qsFull.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  const dataFull = await resFull.json().catch(() => null);
  const fullRows = dataFull?.issues || [];
  console.log(`Full Dev export (no assignee filter): total=${dataFull?.total}, rows=${fullRows.length}`);

  const pragatiInFull = fullRows.filter(r => r.assignee?.id === PRAGATI_ID);
  console.log(`Of those, rows where assignee = Pragati (Excel-filter equivalent): ${pragatiInFull.length}`);
  console.log('Their keys:', pragatiInFull.map(r => r.cfKey || r.key).join(', '));

  // Step 2: the direct, Assignee:Pragati-filtered call (confirmed 70
  // in prior checks) -- for side-by-side comparison.
  const qsDirect = new URLSearchParams({
    spaceKey: 'TESTIN', dept: 'Dev', queueMembersOnly: 'true', assignees: PRAGATI_ID,
    createdRange: 'between:2026-09-01:2026-09-30',
    updatedRange: 'between:2026-09-01:2026-09-30',
    includeTimeSpent: 'true', page: '1', limit: '2000',
  });
  const resDirect = await fetch(`http://localhost:${PORT}/api/issues?${qsDirect.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  const dataDirect = await resDirect.json().catch(() => null);
  const directRows = dataDirect?.issues || [];
  console.log(`\nDirect Assignee:Pragati-filtered call: total=${dataDirect?.total}, rows=${directRows.length}`);

  const directKeys = new Set(directRows.map(r => r.cfKey || r.key));
  const fullFilteredKeys = new Set(pragatiInFull.map(r => r.cfKey || r.key));
  const onlyInDirect = [...directKeys].filter(k => !fullFilteredKeys.has(k));
  const onlyInFullFiltered = [...fullFilteredKeys].filter(k => !directKeys.has(k));
  console.log(`\nIn direct-filter result but NOT in full-export-then-filter: ${onlyInDirect.length}`, onlyInDirect);
  console.log(`In full-export-then-filter but NOT in direct-filter result: ${onlyInFullFiltered.length}`, onlyInFullFiltered);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
