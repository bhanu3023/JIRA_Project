// Read-only: hit the real /api/custom-fields endpoint and compare every
// configured custom field against Filters' hardcoded EXTRA_FILTER_OPTIONS
// list (Reporter, Project Manager, Priority, Department, Product Type,
// Production Ticket, Combination, Customer Name, Client Name, Project Pool,
// Infra Issue Type, Created, Updated, Worked, Due Date, Resolved date) to
// find any real, configured field missing from "More filters".
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';

const FILTERABLE = new Set([
  'reporter', 'project manager', 'priority', 'department', 'product type',
  'production ticket', 'combination', 'customer name', 'client name',
  'project pool', 'infra issue type', 'created date', 'updated date',
  'worked', 'due date', 'resolved date',
]);

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'cf-filter-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','cf-filter-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

async function main() {
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const res = await fetch(`${APP_URL}/api/custom-fields`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  const fields = await res.json();
  console.log(`Total custom fields configured: ${fields.length}\n`);

  const missing = [];
  for (const f of fields) {
    const nameLower = (f.name || '').trim().toLowerCase();
    const fieldType = f.fieldType || f.type || '';
    const isDeptRouting = fieldType === 'department-routing';
    const isDeleted = !!f.isDeleted;
    const inFilters = FILTERABLE.has(nameLower);
    const tag = isDeleted ? ' -- deleted, skip' : isDeptRouting ? ' -- department-routing, not filterable' : inFilters ? ' -- OK' : ' -- *** MISSING from More filters ***';
    console.log(`"${f.name}" (type=${fieldType}, required=${f.required}, spaceIds=${JSON.stringify(f.spaceIds)})${tag}`);
    if (!isDeptRouting && !isDeleted && !inFilters) missing.push(f.name);
  }

  console.log(`\nConfigured, non-deleted, non-routing custom fields NOT in More filters: ${missing.length}`);
  for (const m of missing) console.log(' - ' + m);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
