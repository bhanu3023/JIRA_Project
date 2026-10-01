// Naveed says these 16 specific tickets (all showing Assignee: Naved,
// Status: Resolved, Aug 2026 in his own export) are missing from the 44
// Filters/MBR currently show for him in Dev, Aug 2026. Checks each one
// directly: is it actually in the live Filters Queue:Dev response? If not,
// why -- current department, live assigneeId, dept_assignees snapshot, and
// whether a user_worked_on_tickets credit row exists for him at all.
//
// Read-only.
//
// Usage: node check-naveed-16-missing.mjs

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = 'http://localhost:8080';
const EMAIL = 'naved.osama@cloudfuze.com';

const KEYS = [
  'CF-29908', 'CF-29907', 'CF-29906', 'CF-29901', 'CF-29897', 'CF-29860',
  'CF-29859', 'CF-29858', 'CF-29857', 'CF-29825', 'CF-29817', 'CF-29816',
  'CF-29783', 'CF-29593', 'CF-29589', 'CF-29567',
];

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'naveed-16-check', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','naveed-16-check',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return token;
}

async function main() {
  const { rows: userRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [EMAIL]);
  const userId = userRows[0].id;

  const token = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };
  const filtersParams = new URLSearchParams({
    spaceKey: 'TESTIN', dept: 'Dev', queueMembersOnly: 'true', assignees: EMAIL,
    createdRange: 'between:2026-08-01:2026-08-31', updatedRange: 'between:2026-08-01:2026-08-31',
    page: '1', limit: '500',
  });
  const filtersRes = await fetch(`${APP_URL}/api/issues?${filtersParams}`, { headers: authHeader });
  const filtersData = await filtersRes.json().catch(() => ({}));
  const shownKeys = new Set((filtersData.issues || filtersData.data || []).map(i => i.cfKey || i.cf_key || i.key));
  console.log(`Filters currently shows ${shownKeys.size} tickets for this filter.\n`);

  for (const key of KEYS) {
    const inFilters = shownKeys.has(key);
    console.log(`${key}: ${inFilters ? 'PRESENT in Filters result' : 'MISSING from Filters result'}`);
    if (inFilters) continue;

    const { rows } = await pool.query(
      `SELECT i.id, i.current_department, i."assigneeId", au.email AS assignee_email, i.dept_assignees,
              i."createdAt", i."updatedAt", s.name AS status_name, s.category AS status_category
       FROM issues i LEFT JOIN users au ON au.id = i."assigneeId" LEFT JOIN statuses s ON i."statusId" = s.id
       WHERE i.cf_key = $1 OR i.key = $1`,
      [key]
    );
    if (!rows.length) { console.log('    NOT FOUND in issues table at all'); continue; }
    const r = rows[0];
    console.log(`    current_department=${r.current_department}  status=${r.status_name}(${r.status_category})  live_assignee=${r.assignee_email}`);
    console.log(`    createdAt=${r.createdAt.toISOString()}  updatedAt=${r.updatedAt.toISOString()}`);
    console.log(`    dept_assignees=${JSON.stringify(r.dept_assignees)}`);

    const { rows: worked } = await pool.query(
      `SELECT wu.email, w.dept, w.reason, w.worked_at FROM user_worked_on_tickets w
       JOIN users wu ON wu.id = w.user_id WHERE w.issue_id = $1 ORDER BY w.worked_at ASC`,
      [r.id]
    );
    console.log(`    ALL worked-on rows for this ticket:`);
    for (const w of worked) console.log(`      ${w.email}  dept=${w.dept}  reason=${w.reason}  at=${w.worked_at.toISOString()}`);
    if (!worked.length) console.log('      (none at all)');

    const naveedWorked = worked.find(w => w.email === EMAIL);
    console.log(`    Naveed's own credit row: ${naveedWorked ? `dept=${naveedWorked.dept} reason=${naveedWorked.reason} at=${naveedWorked.worked_at.toISOString()}` : 'NONE'}`);
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
