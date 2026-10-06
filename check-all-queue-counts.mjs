// For every configured queue in every space, sanity-check the Filters
// page's default "Queue: X" count (no other filters, queueMembersOnly=
// true, the live /api/issues call) against:
//   (a) a raw count of tickets currently in that department
//   (b) how many of the queue's own memberIds are orphaned (no matching
//       users row) -- same class of bug just fixed for Migration
//   (c) how many REAL users are currently assigned to tickets in this
//       dept but missing from the queue's memberIds (would silently
//       undercount "Queue: X" for them)
// Read-only.
//
// Usage: node check-all-queue-counts.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'queue-count-audit', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'queue-count-audit', new Date(Date.now() + 3600 * 1000)]
  );

  const { rows: cqRows } = await pool.query(`SELECT space_key, queues FROM custom_queues`);

  for (const cq of cqRows) {
    const queues = cq.queues || [];
    for (const q of queues) {
      if (!q.name) continue;
      const memberIds = q.memberIds || [];

      // (b) orphaned member ids
      let orphaned = [];
      if (memberIds.length) {
        const { rows: existing } = await pool.query(`SELECT id FROM users WHERE id = ANY($1::text[])`, [memberIds]);
        const existingSet = new Set(existing.map(r => r.id));
        orphaned = memberIds.filter(id => !existingSet.has(id));
      }

      // (a) raw baseline: tickets currently in this department, this space
      const { rows: baselineRows } = await pool.query(`
        SELECT COUNT(*)::int AS cnt FROM issues i
        JOIN spaces sp ON sp.id = i."spaceId"
        WHERE sp.key = $1 AND LOWER(i.current_department) = LOWER($2)
      `, [cq.space_key, q.name]);
      const baseline = baselineRows[0]?.cnt ?? 0;

      // (c) real current assignees in this dept missing from memberIds
      const { rows: missingAssignees } = await pool.query(`
        SELECT DISTINCT i."assigneeId" AS id, u."firstName", u."lastName"
        FROM issues i
        JOIN spaces sp ON sp.id = i."spaceId"
        LEFT JOIN users u ON u.id = i."assigneeId"
        WHERE sp.key = $1 AND LOWER(i.current_department) = LOWER($2)
          AND i."assigneeId" IS NOT NULL
          AND NOT (i."assigneeId" = ANY($3::text[]))
      `, [cq.space_key, q.name, memberIds.length ? memberIds : ['__none__']]);

      // live API call: default "Queue: X" view, no other filters
      const qs = new URLSearchParams({ spaceKey: cq.space_key, dept: q.name, queueMembersOnly: 'true', page: '1', limit: '1' });
      const res = await fetch(`http://localhost:${PORT}/api/issues?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => null);
      const liveTotal = data?.total;

      console.log(`\n[${cq.space_key}] Queue: ${q.name}`);
      console.log(`  live Filters total (Queue: ${q.name}, no other filters): ${liveTotal} (HTTP ${res.status})`);
      console.log(`  raw baseline (current_department = ${q.name}): ${baseline}`);
      console.log(`  memberIds: ${memberIds.length} total, ${orphaned.length} orphaned ${orphaned.length ? JSON.stringify(orphaned) : ''}`);
      console.log(`  real current assignees in this dept NOT in memberIds: ${missingAssignees.length}${missingAssignees.length ? ' ' + JSON.stringify(missingAssignees.map(m => `${m.firstName} ${m.lastName} (${m.id})`)) : ''}`);
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
