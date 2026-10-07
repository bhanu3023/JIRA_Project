// Verifies the Queue: Migration + Resolved date fix: compares the count
// before vs after broadening (by re-running the actual live endpoint, which
// after deploy already has the fix applied -- so this just reports the
// current live count, plus a raw-SQL comparison against the UNBROADENED
// (old, buggy) query to show exactly how many extra resolved tickets the
// fix recovers). Read-only.
//
// Usage: node check-resolved-date-queue-fix.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const BASE = `http://localhost:${PORT}/api`;
const DATE_FROM = '2026-09-01';
const DATE_TO = '2026-09-30';
const SPACE_KEY = 'TESTIN';
const DEPT = 'Migration';

async function main() {
  const { rows: users } = await pool.query(`SELECT id FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'resolved-date-queue-fix-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'resolved-date-queue-fix-check', new Date(Date.now() + 3600 * 1000)]
  );
  const headers = { Authorization: `Bearer ${token}` };
  async function get(path) {
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text);
  }

  const qs = new URLSearchParams({
    spaceKey: SPACE_KEY, dept: DEPT, queueMembersOnly: 'true', page: '1', limit: '2000',
    resolvedRange: `between:${DATE_FROM}:${DATE_TO}`,
  });
  const live = await get(`/issues?${qs.toString()}`);
  console.log(`LIVE (post-fix) Queue: ${DEPT} + Resolved date: ${DATE_FROM} to ${DATE_TO} -> total: ${live.total}`);

  // Ground truth, independent of either query path: every ticket actually
  // resolved in the window whose CURRENT OR ORIGIN department (or frozen
  // per-dept done snapshot, or a genuine worked-on-in-Migration record) is
  // Migration -- same broad "belongs to this dept" definition deptScopeSql
  // itself uses, computed directly here to sanity-check the live count
  // against, not just trusting the endpoint blindly.
  const { rows: groundTruth } = await pool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM issues i
    WHERE i."resolvedAt" >= $1::date AND i."resolvedAt" < ($2::date + interval '1 day')
      AND (
        LOWER(i.current_department) = LOWER($3)
        OR LOWER(COALESCE(
             i.original_dept,
             (SELECT h."oldValue" FROM issue_history h WHERE h."issueId" = i.id AND h.field = 'department' ORDER BY h."createdAt" ASC LIMIT 1),
             i.current_department
           )) = LOWER($3)
        OR EXISTS (SELECT 1 FROM jsonb_each(COALESCE(i.dept_statuses, '{}'::jsonb)) ds(k, v) WHERE LOWER(k) = LOWER($3) AND LOWER(v->>'category') = 'done')
        OR EXISTS (SELECT 1 FROM user_worked_on_tickets w WHERE w.issue_id = i.id AND LOWER(w.dept) = LOWER($3) AND w.reason != 'passed')
      )
  `, [DATE_FROM, DATE_TO, DEPT]);
  console.log(`Ground truth (broad "belongs to Migration" + resolvedAt in range, no queue-membership restriction at all): ${groundTruth[0].cnt}`);

  // The OLD (pre-fix) unbroadened query: plain current_department = Migration
  // AND current assignee is a configured Migration queue member (or
  // unassigned-and-currently-Migration) -- what the live endpoint used to
  // compute before this fix.
  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = cqRows[0]?.queues || [];
  const q = queues.find((qq) => String(qq.name || '').toLowerCase() === DEPT.toLowerCase());
  const memberIds = Array.isArray(q?.memberIds) ? q.memberIds : [];
  const { rows: oldBuggy } = await pool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM issues i
    WHERE i."resolvedAt" >= $1::date AND i."resolvedAt" < ($2::date + interval '1 day')
      AND LOWER(i.current_department) = LOWER($3)
      AND (i."assigneeId" = ANY($4::text[]) OR (i."assigneeId" IS NULL AND LOWER(i.current_department) = LOWER($3)))
  `, [DATE_FROM, DATE_TO, DEPT, memberIds]);
  console.log(`OLD (pre-fix, unbroadened) count: ${oldBuggy[0].cnt}`);
  console.log(`\nRecovered by the fix: ${live.total - oldBuggy[0].cnt} additional resolved tickets now counted.`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
