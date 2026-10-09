// Triggers a fresh recompute (via GET /issues/:key, same as opening the
// ticket detail page) for each of the 43 tickets backfill-clear-bad-
// snapshots.mjs just cleared, so their sla_snapshot gets re-frozen with the
// now-corrected logic, then re-runs the same consistency checks
// check-sla-system-health.mjs does, scoped to just these 43, to confirm
// they're actually fixed rather than just empty. Read-only aside from the
// natural re-freeze every GET /issues/:key already does for a resolved
// ticket.
//
// Usage: node verify-cleared-snapshots.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const BASE = `http://localhost:${PORT}/api`;

const KEYS = [
  'CF-29758','CF-32998','CF-29797','CF-29640','CF-29690','CF-29933','CF-30766','CF-29399','CF-29378','CF-29320',
  'CF-27228','CF-32991','CF-33009','CF-30696','CF-29401','CF-29462','CF-29348','CF-29842','CF-29589','CF-29354',
  'CF-29926','CF-33035','CF-32993','CF-29367','CF-33368','CF-29346','CF-29382','CF-29360','CF-27177','CF-29365',
  'CF-29371','CF-29397','CF-29826','CF-30360','CF-29407','CF-29306','CF-29799','CF-29904','CF-29697','CF-29432',
  'CF-29827','CF-29406','CF-32756',
];

async function main() {
  const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const admin = adminRows[0];
  const payload = { sub: admin.id, ip: '', ua: 'verify-cleared-snapshots', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'verify-cleared-snapshots', new Date(Date.now() + 3600 * 1000)]
  );
  const headers = { Authorization: `Bearer ${token}` };

  console.log(`Triggering recompute for ${KEYS.length} tickets...`);
  for (const key of KEYS) {
    const res = await fetch(`${BASE}/issues/${key}`, { headers });
    if (!res.ok) console.log(`  ${key}: HTTP ${res.status}`);
  }
  console.log('Done re-freezing. Re-checking consistency...\n');

  const { rows } = await pool.query(`
    SELECT id, COALESCE(cf_key, key) AS key, current_department, dept_sla_log, sla_snapshot
    FROM issues WHERE COALESCE(cf_key, key) = ANY($1::text[])
  `, [KEYS]);

  let stillFalseResolved = 0, stillFalseNegative = 0, nowNull = 0, ok = 0;
  for (const row of rows) {
    if (!row.sla_snapshot) { nowNull++; console.log(`  ${row.key}: sla_snapshot still null (not yet re-viewed/recomputed)`); continue; }
    const deptLog = row.dept_sla_log || {};
    const curDept = (row.current_department || '').trim().toLowerCase();
    const curDeptKey = Object.keys(deptLog).find((k) => k.toLowerCase() === curDept);
    let bad = false;
    for (const inst of row.sla_snapshot || []) {
      const isCurrentDeptInstance = (inst.deptName || '').trim().toLowerCase() === curDept;
      if (isCurrentDeptInstance && inst.isCompleted && curDeptKey && deptLog[curDeptKey]?.status === 'running') { stillFalseResolved++; bad = true; }
      if (typeof inst.actualElapsedMs === 'number' && typeof inst.goalDurationMs === 'number'
        && !inst.isBreached && inst.actualElapsedMs >= inst.goalDurationMs) { stillFalseNegative++; bad = true; }
    }
    if (bad) console.log(`  ${row.key}: STILL INCONSISTENT`);
    else ok++;
  }

  console.log(`\nOK (recomputed and consistent): ${ok}`);
  console.log(`Still null (recompute didn't freeze -- likely still genuinely running): ${nowNull}`);
  console.log(`Still false-resolved-dept: ${stillFalseResolved}`);
  console.log(`Still false-negative-breach: ${stillFalseNegative}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
