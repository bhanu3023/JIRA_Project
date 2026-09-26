// 171 results for TESTIN/Queue:Dev/Created+Updated 9/14-9/20 -- but only 15
// of those 171 are CURRENTLY in the Dev department; 140 are in Migration.
// The backend code deliberately broadens "Queue: Dev" to include tickets
// someone genuinely worked on in Dev before it moved elsewhere (heavily
// fixed/tuned in past sessions for real false-negative bugs), gated on:
// (a) the worked-on record's reason != 'passed' (a real hand-off, not just
// routing), and (b) the user being an actual configured member of Dev's
// queue (deptQueueMemberIds) -- but ONLY if Dev has a configured queue at
// all; if it doesn't, that member restriction silently no-ops and ANY
// user's worked-on record for dept='Dev' counts. Checking whether that's
// what's happening here: does TESTIN have a configured "Dev" queue with
// real members, and who actually logged the worked-on records behind the
// 140 Migration-department matches.
//
// Read-only.
//
// Usage: node check-dev-queue-broadening.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = cq[0]?.queues || [];
  console.log(`TESTIN configured queues: ${queues.map((q) => q.name).join(', ') || 'NONE'}`);
  const devQueue = queues.find((q) => String(q.name || '').toLowerCase() === 'dev');
  console.log(`Dev queue config: ${devQueue ? JSON.stringify({ name: devQueue.name, memberCount: (devQueue.memberIds || []).length }) : 'NOT FOUND -- member restriction would be skipped entirely'}`);
  if (devQueue?.memberIds?.length) {
    const { rows: members } = await pool.query(`SELECT id, "firstName", "lastName", email FROM users WHERE id = ANY($1::text[])`, [devQueue.memberIds]);
    console.log('Dev queue members:', members.map((m) => `${m.firstName} ${m.lastName}`).join(', '));
  }

  // Who logged the worked-on records that make Migration-department tickets
  // match Queue:Dev in this window, and with what reason
  const { rows: worked } = await pool.query(
    `SELECT w.reason, u."firstName", u."lastName", COUNT(*) AS cnt
     FROM user_worked_on_tickets w
     JOIN issues i ON i.id = w.issue_id
     JOIN spaces sp ON sp.id = i."spaceId"
     LEFT JOIN users u ON u.id = w.user_id
     WHERE sp.key = 'TESTIN' AND LOWER(w.dept) = 'dev' AND i.current_department = 'Migration'
       AND (i."createdAt" >= '2026-09-14' AND i."createdAt" < '2026-09-21'
         OR i."updatedAt" >= '2026-09-14' AND i."updatedAt" < '2026-09-21')
     GROUP BY w.reason, u."firstName", u."lastName"
     ORDER BY cnt DESC`
  );
  console.log('\nWho logged dept=Dev worked-on records for the Migration-department tickets in this window:');
  for (const r of worked) console.log(`  ${r.firstName} ${r.lastName}  reason=${r.reason}  count=${r.cnt}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
