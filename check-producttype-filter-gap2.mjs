// v2: instead of re-deriving the complex dept-scope SQL (which includes
// tickets worked in Dev during the window even if since moved elsewhere),
// just diff the actual ticket KEYS returned by the live API for both
// scenarios, then look up productType directly for whichever keys got
// dropped. Read-only.
//
// Usage: node check-producttype-filter-gap2.mjs
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
  const payload = { sub: user.id, ip: '', ua: 'producttype-gap-check-v2', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'producttype-gap-check-v2', new Date(Date.now() + 3600 * 1000)]
  );

  const baseParams = {
    spaceKey: 'TESTIN', dept: 'Dev', queueMembersOnly: 'true',
    createdRange: 'between:2026-09-01:2026-09-30',
    updatedRange: 'between:2026-09-01:2026-09-30',
    includeTimeSpent: 'true',
  };

  async function fetchKeys(extra) {
    const qs = new URLSearchParams({ ...baseParams, ...extra, page: '1', limit: '2000' });
    const res = await fetch(`http://localhost:${PORT}/api/issues?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => null);
    return { total: data?.total, keys: new Set((data?.issues || []).map((i) => i.cfKey || i.key)) };
  }

  const baseline = await fetchKeys({});
  const allTypes = await fetchKeys({ productType: PRODUCT_TYPE_OPTIONS.join(',') });

  console.log(`baseline total=${baseline.total}, fetched ${baseline.keys.size} keys`);
  console.log(`all-types total=${allTypes.total}, fetched ${allTypes.keys.size} keys`);

  const dropped = [...baseline.keys].filter((k) => !allTypes.keys.has(k));
  console.log(`\nDropped when Product Type filter applied: ${dropped.length} tickets`);

  if (dropped.length) {
    const { rows } = await pool.query(
      `SELECT COALESCE(cf_key, key) AS key, "productType", current_department FROM issues WHERE cf_key = ANY($1::text[]) OR key = ANY($1::text[])`,
      [dropped]
    );
    const byKey = new Map(rows.map(r => [r.key, r]));
    for (const k of dropped) {
      const r = byKey.get(k);
      console.log(`  ${k}: productType=${JSON.stringify(r?.productType)} current_department=${r?.current_department}`);
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
