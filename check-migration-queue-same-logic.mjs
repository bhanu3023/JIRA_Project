// Same verification just done for Queue: Dev, but for Queue: Migration --
// it runs through the exact same shared code (dept-scoped branch,
// parameterized by deptParam), so the same correctness properties SHOULD
// hold, but "should" isn't good enough to tell the user yes/no on trust --
// checking for real: does Migration have a configured queue with real
// members, and for a sample of currently-non-Migration tickets that would
// match Queue: Migration via the worked-on broadening, is there always a
// genuine Migration-queue-member record backing the match.
//
// Read-only.
//
// Usage: node check-migration-queue-same-logic.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = cq[0]?.queues || [];
  const migQueue = queues.find((q) => String(q.name || '').toLowerCase() === 'migration');
  console.log(`Migration queue config: ${migQueue ? `memberCount=${(migQueue.memberIds || []).length}` : 'NOT FOUND'}`);
  const memberIds = new Set(migQueue?.memberIds || []);

  // Tickets NOT currently in Migration, but with a real (non-'passed')
  // worked-on record for dept='Migration' -- these are the ones that would
  // be pulled into "Queue: Migration" via the same broadening mechanism
  const { rows: tickets } = await pool.query(
    `SELECT DISTINCT COALESCE(i.cf_key, i.key) AS key, i.current_department
     FROM issues i JOIN spaces sp ON sp.id = i."spaceId"
     JOIN user_worked_on_tickets w ON w.issue_id = i.id AND LOWER(w.dept) = 'migration' AND w.reason != 'passed'
     WHERE sp.key = 'TESTIN' AND i.current_department != 'Migration'
     LIMIT 15`
  );
  console.log(`\nSample of ${tickets.length} non-Migration tickets with a real Migration worked-on record:`);
  for (const t of tickets) {
    const { rows: workers } = await pool.query(
      `SELECT w.user_id, w.reason, u."firstName", u."lastName" FROM user_worked_on_tickets w
       JOIN issues i ON i.id = w.issue_id LEFT JOIN users u ON u.id = w.user_id
       WHERE COALESCE(i.cf_key, i.key) = $1 AND LOWER(w.dept) = 'migration' AND w.reason != 'passed'`,
      [t.key]
    );
    const anyGenuineMember = workers.some((w) => memberIds.has(w.user_id));
    console.log(`  ${t.key} (now ${t.current_department}): ${workers.map((w) => `${w.firstName} ${w.lastName}${memberIds.has(w.user_id) ? ' [MEMBER]' : ' [not a member]'}`).join(', ')} -- ${anyGenuineMember ? 'backed by a genuine member' : 'NO GENUINE MEMBER -- would be a real bug'}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
