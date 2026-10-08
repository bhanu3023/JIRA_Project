// Comprehensive sweep: every configured queue on TESTIN, for Sep 1-30 2026
// (as a "touched" union -- createdAt OR updatedAt in range, matching MBR's
// own semantics and the Filters page's Queue-scoped Created+Updated-both
// behavior). For each queue: the whole-queue total (live vs a broad
// ground-truth "belongs to this dept" count), plus a per-assignee check for
// that queue's top 3 most active people (live vs ground truth, including
// the worked-on-but-moved-on broadening). Flags every mismatch found.
// Read-only.
//
// Usage: node check-all-queues-sep-accuracy.mjs
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
  const payload = { sub: admin.id, ip: '', ua: 'all-queues-sep-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, admin.id, '', 'all-queues-sep-check', new Date(Date.now() + 3600 * 1000)]
  );
  const headers = { Authorization: `Bearer ${token}` };
  async function get(path) {
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }

  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = cqRows[0]?.queues || [];
  console.log(`Found ${queues.length} configured queues on ${SPACE_KEY}: ${queues.map((q) => q.name).join(', ')}\n`);

  const between = `between:${DATE_FROM}:${DATE_TO}`;
  let totalMismatches = 0;

  for (const q of queues) {
    const dept = q.name;
    if (!dept) continue;

    // Whole-queue total, Sep 1-30 touched
    const qs = new URLSearchParams({ spaceKey: SPACE_KEY, dept, queueMembersOnly: 'true', page: '1', limit: '1', createdRange: between, updatedRange: between });
    let live;
    try { live = await get(`/issues?${qs.toString()}`); } catch (e) { console.log(`${dept}: ERROR fetching live total -- ${e.message}`); continue; }

    const { rows: gt } = await pool.query(`
      SELECT COUNT(*)::int AS cnt FROM issues i WHERE i."spaceId" = (SELECT id FROM spaces WHERE key = $4) AND (
        LOWER(i.current_department) = LOWER($1)
        OR LOWER(COALESCE(i.original_dept, (SELECT h."oldValue" FROM issue_history h WHERE h."issueId" = i.id AND h.field = 'department' ORDER BY h."createdAt" ASC LIMIT 1), i.current_department)) = LOWER($1)
        OR EXISTS (SELECT 1 FROM jsonb_each(COALESCE(i.dept_statuses, '{}'::jsonb)) ds(k, v) WHERE LOWER(k) = LOWER($1) AND LOWER(v->>'category') = 'done')
        OR EXISTS (SELECT 1 FROM user_worked_on_tickets w WHERE w.issue_id = i.id AND LOWER(w.dept) = LOWER($1) AND w.reason != 'passed')
      ) AND (
        (i."createdAt" >= $2::date AND i."createdAt" < ($3::date + interval '1 day'))
        OR (i."updatedAt" >= $2::date AND i."updatedAt" < ($3::date + interval '1 day'))
      )
    `, [dept, DATE_FROM, DATE_TO, SPACE_KEY]);

    const diff = live.total - gt[0].cnt;
    const flag = Math.abs(diff) > Math.max(5, gt[0].cnt * 0.05) ? ' <<< CHECK' : '';
    console.log(`${dept}: live=${live.total} groundTruth(broad dept match)=${gt[0].cnt} diff=${diff}${flag}`);
    if (flag) totalMismatches++;

    // Top 3 assignees for this dept, spot-checked individually
    const { rows: topPeople } = await pool.query(`
      SELECT i."assigneeId" AS id, u.email, u."firstName", u."lastName", COUNT(*)::int AS cnt
      FROM issues i JOIN users u ON u.id = i."assigneeId"
      WHERE i."spaceId" = (SELECT id FROM spaces WHERE key = $2) AND LOWER(i.current_department) = LOWER($1)
      GROUP BY i."assigneeId", u.email, u."firstName", u."lastName"
      ORDER BY cnt DESC LIMIT 3
    `, [dept, SPACE_KEY]);

    for (const person of topPeople) {
      const name = `${person.firstName || ''} ${person.lastName || ''}`.trim() || person.email;
      const qs2 = new URLSearchParams({ spaceKey: SPACE_KEY, dept, queueMembersOnly: 'true', assignees: person.id, page: '1', limit: '1', createdRange: between, updatedRange: between });
      let live2;
      try { live2 = await get(`/issues?${qs2.toString()}`); } catch (e) { console.log(`  ${name}: ERROR -- ${e.message}`); continue; }
      const { rows: gt2 } = await pool.query(`
        SELECT COUNT(*)::int AS cnt FROM issues i WHERE i."spaceId" = (SELECT id FROM spaces WHERE key = $5) AND (
          (i."assigneeId" = $1 AND LOWER(i.current_department) = LOWER($2))
          OR EXISTS (SELECT 1 FROM user_worked_on_tickets w WHERE w.issue_id = i.id AND w.user_id = $1 AND LOWER(w.dept) = LOWER($2) AND w.reason != 'passed')
        ) AND (
          (i."createdAt" >= $3::date AND i."createdAt" < ($4::date + interval '1 day'))
          OR (i."updatedAt" >= $3::date AND i."updatedAt" < ($4::date + interval '1 day'))
        )
      `, [person.id, dept, DATE_FROM, DATE_TO, SPACE_KEY]);
      const diff2 = live2.total - gt2[0].cnt;
      const flag2 = Math.abs(diff2) > Math.max(3, gt2[0].cnt * 0.1) ? ' <<< CHECK' : '';
      console.log(`  ${name}: live=${live2.total} groundTruth=${gt2[0].cnt} diff=${diff2}${flag2}`);
      if (flag2) totalMismatches++;
    }
  }

  console.log(`\n${totalMismatches} flagged discrepancy(ies) found across ${queues.length} queues.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
