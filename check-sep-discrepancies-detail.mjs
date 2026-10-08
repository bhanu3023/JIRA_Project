// Ticket-level detail on the two biggest flags from the all-queues sweep:
// Migration's whole-queue total (live=644 vs groundTruth=686, -42) and
// Ravi Srivastava's Dev count (live=79 vs groundTruth=53, +26) for Sep 1-30
// 2026. Finds the EXACT tickets in each direction's diff and shows enough
// fields to explain why. Read-only.
//
// Usage: node check-sep-discrepancies-detail.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const BASE = `http://localhost:${PORT}/api`;
const SPACE_KEY = 'TESTIN';
const DATE_FROM = '2026-09-01';
const DATE_TO = '2026-09-30';

async function main() {
  const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const admin = adminRows[0];
  const payload = { sub: admin.id, ip: '', ua: 'sep-discrepancy-detail', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'sep-discrepancy-detail', new Date(Date.now() + 3600 * 1000)]
  );
  const headers = { Authorization: `Bearer ${token}` };
  async function get(path) {
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }

  const between = `between:${DATE_FROM}:${DATE_TO}`;

  // === Migration whole-queue ===
  console.log('=== Migration whole-queue, Sep 1-30 ===');
  const qsM = new URLSearchParams({ spaceKey: SPACE_KEY, dept: 'Migration', queueMembersOnly: 'true', page: '1', limit: '2000', createdRange: between, updatedRange: between });
  const liveM = await get(`/issues?${qsM.toString()}`);
  const liveMKeys = new Set((liveM.issues || []).map((i) => i.cfKey ?? i.key));
  console.log(`Live: ${liveMKeys.size}`);

  const { rows: gtMRows } = await pool.query(`
    SELECT COALESCE(cf_key, key) AS key, current_department, original_dept, "assigneeId"
    FROM issues i WHERE i."spaceId" = (SELECT id FROM spaces WHERE key = $4) AND (
      LOWER(i.current_department) = LOWER($1)
      OR LOWER(COALESCE(i.original_dept, (SELECT h."oldValue" FROM issue_history h WHERE h."issueId" = i.id AND h.field = 'department' ORDER BY h."createdAt" ASC LIMIT 1), i.current_department)) = LOWER($1)
      OR EXISTS (SELECT 1 FROM jsonb_each(COALESCE(i.dept_statuses, '{}'::jsonb)) ds(k, v) WHERE LOWER(k) = LOWER($1) AND LOWER(v->>'category') = 'done')
      OR EXISTS (SELECT 1 FROM user_worked_on_tickets w WHERE w.issue_id = i.id AND LOWER(w.dept) = LOWER($1) AND w.reason != 'passed')
    ) AND (
      (i."createdAt" >= $2::date AND i."createdAt" < ($3::date + interval '1 day'))
      OR (i."updatedAt" >= $2::date AND i."updatedAt" < ($3::date + interval '1 day'))
    )
  `, ['Migration', DATE_FROM, DATE_TO, SPACE_KEY]);
  const gtMKeys = new Set(gtMRows.map((r) => r.key));
  console.log(`Ground truth: ${gtMKeys.size}`);

  const inGtNotLive = gtMRows.filter((r) => !liveMKeys.has(r.key));
  console.log(`\nIn ground truth but NOT live (${inGtNotLive.length}), sample of 15:`);
  for (const r of inGtNotLive.slice(0, 15)) {
    console.log(`  ${r.key}: current_dept=${r.current_department} origin=${r.original_dept} assigneeId=${r.assigneeId}`);
  }

  // === Ravi Dev ===
  console.log('\n\n=== Ravi Srivastava, Queue: Dev, Sep 1-30 ===');
  const { rows: raviRows } = await pool.query(`SELECT id FROM users WHERE email = 'ravi.srivastava@cloudfuze.com'`);
  const ravi = raviRows[0];
  const qsR = new URLSearchParams({ spaceKey: SPACE_KEY, dept: 'Dev', queueMembersOnly: 'true', assignees: ravi.id, page: '1', limit: '200', createdRange: between, updatedRange: between });
  const liveR = await get(`/issues?${qsR.toString()}`);
  const liveRKeys = new Set((liveR.issues || []).map((i) => i.cfKey ?? i.key));
  console.log(`Live: ${liveRKeys.size}`);

  const { rows: gtRRows } = await pool.query(`
    SELECT COALESCE(cf_key, key) AS key, current_department, "assigneeId"
    FROM issues i WHERE i."spaceId" = (SELECT id FROM spaces WHERE key = $5) AND (
      (i."assigneeId" = $1 AND LOWER(i.current_department) = LOWER($2))
      OR EXISTS (SELECT 1 FROM user_worked_on_tickets w WHERE w.issue_id = i.id AND w.user_id = $1 AND LOWER(w.dept) = LOWER($2) AND w.reason != 'passed')
    ) AND (
      (i."createdAt" >= $3::date AND i."createdAt" < ($4::date + interval '1 day'))
      OR (i."updatedAt" >= $3::date AND i."updatedAt" < ($4::date + interval '1 day'))
    )
  `, [ravi.id, 'Dev', DATE_FROM, DATE_TO, SPACE_KEY]);
  const gtRKeys = new Set(gtRRows.map((r) => r.key));
  console.log(`Ground truth: ${gtRKeys.size}`);

  const inLiveNotGt = [...liveRKeys].filter((k) => !gtRKeys.has(k));
  console.log(`\nIn live but NOT ground truth (${inLiveNotGt.length}), sample of 15:`);
  if (inLiveNotGt.length) {
    const { rows: detailRows } = await pool.query(
      `SELECT COALESCE(cf_key, key) AS key, current_department, "assigneeId", "createdAt", "updatedAt" FROM issues WHERE COALESCE(cf_key, key) = ANY($1::text[])`,
      [inLiveNotGt.slice(0, 15)]
    );
    for (const r of detailRows) {
      const { rows: workedRows } = await pool.query(
        `SELECT wu.email, w.dept, w.reason, w.worked_at FROM user_worked_on_tickets w JOIN users wu ON wu.id = w.user_id WHERE w.issue_id = (SELECT id FROM issues WHERE COALESCE(cf_key,key)=$1)`,
        [r.key]
      );
      console.log(`  ${r.key}: current_dept=${r.current_department} assigneeId=${r.assigneeId} created=${r.createdAt} updated=${r.updatedAt}`);
      console.log(`    worked_on rows: ${JSON.stringify(workedRows)}`);
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
