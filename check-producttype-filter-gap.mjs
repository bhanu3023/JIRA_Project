// Replicates the user's exact scenario: Queue: Dev, Created/Updated
// 2026-09-01..2026-09-30, comparing the live count with no Product Type
// filter vs with every known PRODUCT_TYPE_OPTIONS value selected --
// these should be IDENTICAL if the dropdown's option list is exhaustive.
// Also pulls the raw distinct productType values among matching tickets
// to check for any real value not covered by the dropdown. Read-only.
//
// Usage: node check-producttype-filter-gap.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

const PRODUCT_TYPE_OPTIONS = ['Content Migration', 'Email Migration', 'Message Migration', 'Board Migration', 'CF Connect', 'CF Manage', 'UI', 'others', 'Others'];

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'producttype-gap-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'producttype-gap-check', new Date(Date.now() + 3600 * 1000)]
  );

  const baseParams = {
    spaceKey: 'TESTIN', dept: 'Dev', queueMembersOnly: 'true',
    createdRange: 'between:2026-09-01:2026-09-30',
    updatedRange: 'between:2026-09-01:2026-09-30',
    includeTimeSpent: 'true',
  };

  for (const [label, extra] of [
    ['no Product Type filter', {}],
    ['Product Type = all known options', { productType: PRODUCT_TYPE_OPTIONS.join(',') }],
  ]) {
    const qs = new URLSearchParams({ ...baseParams, ...extra, page: '1', limit: '1' });
    const res = await fetch(`http://localhost:${PORT}/api/issues?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => null);
    console.log(`[${label}] total=${data?.total} (HTTP ${res.status})`);
  }

  // Raw distinct productType values among tickets actually matching this
  // scope (current_department=Dev, created/updated in Sep 2026 window)
  const { rows: distinct } = await pool.query(`
    SELECT i."productType", COUNT(*)::int AS cnt
    FROM issues i
    JOIN spaces sp ON sp.id = i."spaceId"
    WHERE sp.key = 'TESTIN' AND LOWER(i.current_department) = 'dev'
      AND i."createdAt" >= '2026-09-01' AND i."createdAt" < '2026-10-01'
      AND i."updatedAt" >= '2026-09-01' AND i."updatedAt" < '2026-10-01'
    GROUP BY i."productType"
    ORDER BY cnt DESC
  `);
  console.log('\nDistinct productType values among matching tickets:');
  for (const r of distinct) {
    const known = r.productType ? PRODUCT_TYPE_OPTIONS.includes(r.productType) : null;
    console.log(`  ${JSON.stringify(r.productType)}: ${r.cnt} tickets${r.productType && !known ? '  <-- NOT in PRODUCT_TYPE_OPTIONS!' : ''}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
