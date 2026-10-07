// Compares MBR's "Customer Engineering" (eng) and "Migration ENT + SMB"
// (ent + smb) tabs against the Filters page's equivalent "Queue: Dev" and
// "Queue: Migration" counts, for Sep 1-30 2026 -- per explicit report of a
// count mismatch between the two pages for this exact range/depts.
//
// Checks three possible explanations:
//   1. Date semantics: MBR unions createdAt OR updatedAt into one "touched"
//      range; Filters' UI can only select createdRange-only, updatedRange-
//      only, or BOTH as an intersection (never a union) -- so comparing MBR
//      against "both chips active" in Filters compares a union to an
//      intersection, which will legitimately differ.
//   2. Roster drift: MBR's Migration ENT/SMB tabs use a hand-maintained
//      fixed email list (TEAM_ROSTER.ent/.smb in jira-pg-api.ts), NOT the
//      live Migration queue's configured memberIds the way Filters' own
//      "Queue: Migration" does -- anyone in the live queue but missing from
//      the hardcoded list undercounts in MBR vs Filters.
//   3. Something else entirely, if none of the above account for it.
// Read-only.
//
// Usage: node check-mbr-vs-filters-sep-count.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const BASE = `http://localhost:${PORT}/api`;
const DATE_FROM = '2026-09-01';
const DATE_TO = '2026-09-30';
const SPACE_KEY = 'TESTIN'; // hardcoded in reports/mbr-team's roster lookup

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  if (!user) throw new Error('admin user not found');
  const payload = { sub: user.id, ip: '', ua: 'mbr-vs-filters-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'mbr-vs-filters-check', new Date(Date.now() + 3600 * 1000)]
  );
  const headers = { Authorization: `Bearer ${token}` };

  async function get(path) {
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text);
  }

  console.log(`=== MBR team tabs, ${DATE_FROM} to ${DATE_TO} ===`);
  const eng = await get(`/reports/mbr-team?team=eng&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`);
  const ent = await get(`/reports/mbr-team?team=ent&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`);
  const smb = await get(`/reports/mbr-team?team=smb&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`);
  console.log('Customer Engineering (eng) totalMatched:', eng.totalMatched);
  console.log('Migration ENT totalMatched:', ent.totalMatched);
  console.log('Migration SMB totalMatched:', smb.totalMatched);
  console.log('Migration ENT+SMB combined:', (ent.totalMatched || 0) + (smb.totalMatched || 0));

  async function filtersTotal(dept, rangeParams) {
    const qs = new URLSearchParams({ spaceKey: SPACE_KEY, dept, queueMembersOnly: 'true', page: '1', limit: '50', ...rangeParams });
    const data = await get(`/issues?${qs.toString()}`);
    return data.total;
  }
  async function filtersIds(dept, rangeParams) {
    const qs = new URLSearchParams({ spaceKey: SPACE_KEY, dept, queueMembersOnly: 'true', page: '1', limit: '2000', ...rangeParams });
    const data = await get(`/issues?${qs.toString()}`);
    return new Set((data.issues || []).map((i) => i.id));
  }

  const between = `between:${DATE_FROM},${DATE_TO}`;

  console.log(`\n=== Filters "Queue: Dev", ${SPACE_KEY}, ${DATE_FROM} to ${DATE_TO} ===`);
  console.log('createdRange only:', await filtersTotal('Dev', { createdRange: between }));
  console.log('updatedRange only:', await filtersTotal('Dev', { updatedRange: between }));
  console.log('created+updated (intersection, matches today\'s UI when both chips active):', await filtersTotal('Dev', { createdRange: between, updatedRange: between }));
  const devCreatedIds = await filtersIds('Dev', { createdRange: between });
  const devUpdatedIds = await filtersIds('Dev', { updatedRange: between });
  console.log('union(created, updated) -- matches MBR\'s own "touched" semantics:', new Set([...devCreatedIds, ...devUpdatedIds]).size);

  console.log(`\n=== Filters "Queue: Migration", ${SPACE_KEY}, ${DATE_FROM} to ${DATE_TO} ===`);
  console.log('createdRange only:', await filtersTotal('Migration', { createdRange: between }));
  console.log('updatedRange only:', await filtersTotal('Migration', { updatedRange: between }));
  console.log('created+updated (intersection, matches today\'s UI when both chips active):', await filtersTotal('Migration', { createdRange: between, updatedRange: between }));
  const migCreatedIds = await filtersIds('Migration', { createdRange: between });
  const migUpdatedIds = await filtersIds('Migration', { updatedRange: between });
  const migUnionIds = new Set([...migCreatedIds, ...migUpdatedIds]);
  console.log('union(created, updated) -- matches MBR\'s own "touched" semantics:', migUnionIds.size);

  console.log(`\n=== Roster comparison: live Migration queue vs MBR's hardcoded ENT+SMB list ===`);
  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = cqRows[0]?.queues || [];
  const migQueue = queues.find((q) => String(q.name || '').toLowerCase() === 'migration');
  const liveMemberIds = Array.isArray(migQueue?.memberIds) ? migQueue.memberIds : [];
  let liveMigrationEmails = [];
  if (liveMemberIds.length) {
    const { rows } = await pool.query(`SELECT email FROM users WHERE id = ANY($1::text[]) AND email IS NOT NULL`, [liveMemberIds]);
    liveMigrationEmails = rows.map((r) => String(r.email).toLowerCase()).sort();
  }
  console.log(`Live Migration queue roster (${liveMigrationEmails.length}):`, liveMigrationEmails);

  const TEAM_ROSTER_ENT = [
    'abhishek.sakala@cloudfuze.com', 'arun@cloudfuze.com', 'chaitanya.gupta@cloudfuze.com', 'chandra.mouli@cloudfuze.com',
    'davidraj.dumpala@cloudfuze.com', 'ganesh.kondameedi@cloudfuze.com', 'harshith.kaduluri@cloudfuze.com', 'lakshmareddy@cloudfuze.com',
    'lakshmi.prasanna@cloudfuze.com', 'manoj.bathula@cloudfuze.com', 'pallavi.kosuvaripalli@cloudfuze.com', 'pranavi@cloudfuze.com',
    'tanmai.arangi@cloudfuze.com',
  ];
  const TEAM_ROSTER_SMB = [
    'abhishikth.yenugula@cloudfuze.com', 'ajay.singh@cloudfuze.com', 'ramana.reddy@cloudfuze.com', 'amulya.anapuram@cloudfuze.com',
    'dathu.kaluvala@cloudfuze.com', 'habeebunnisa.begum@cloudfuze.com', 'harika.velidi@cloudfuze.com', 'meena.lakshmi@cloudfuze.com',
    'neelima.krotta@cloudfuze.com', 'raghu.yellani@cloudfuze.com', 'ranadeep.muddam@cloudfuze.com', 'ravi.hemanth@cloudfuze.com',
    'saikumar.kustapuram@cloudfuze.com', 'siva.kota@cloudfuze.com', 'sravan.kesaram@cloudfuze.com', 'sriram.ramakrishnan@cloudfuze.com',
    'swaroop@cloudfuze.com', 'vijendar.burgula@cloudfuze.com', 'vineetha.yenti@cloudfuze.com',
  ];
  const hardcodedSet = new Set([...TEAM_ROSTER_ENT, ...TEAM_ROSTER_SMB]);
  const missingFromMbr = liveMigrationEmails.filter((e) => !hardcodedSet.has(e));
  const extraInMbr = [...hardcodedSet].filter((e) => !liveMigrationEmails.includes(e));
  console.log(`In live Migration queue but MISSING from MBR's ENT+SMB hardcoded list (${missingFromMbr.length}):`, missingFromMbr);
  console.log(`In MBR's ENT+SMB hardcoded list but NOT in the live Migration queue (${extraInMbr.length}):`, extraInMbr);

  // Which of the union-matched Migration tickets belong to a person missing
  // from the hardcoded list -- these are exactly the tickets MBR undercounts.
  if (missingFromMbr.length && migUnionIds.size) {
    const { rows: ticketRows } = await pool.query(
      `SELECT i.id, COALESCE(i.cf_key, i.key) AS key, u.email AS assignee_email
       FROM issues i LEFT JOIN users u ON u.id = i."assigneeId"
       WHERE i.id = ANY($1::text[])`,
      [[...migUnionIds]]
    );
    const affected = ticketRows.filter((r) => r.assignee_email && missingFromMbr.includes(String(r.assignee_email).toLowerCase()));
    console.log(`\nMigration tickets in this range assigned to someone missing from MBR's list (${affected.length}):`, affected.map((r) => `${r.key} (${r.assignee_email})`));
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
