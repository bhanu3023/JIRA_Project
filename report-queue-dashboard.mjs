/**
 * report-queue-dashboard.mjs
 * READ-ONLY sanity check for the new admin "Queue Dashboard" view on
 * /my-dashboard (GET /my-dashboard?viewedQueue=<dept>). Nothing is written.
 *
 * Recomputes, with plain SQL, the same numbers that endpoint returns under
 * its "queueDashboard" key, so you can eyeball them against what the UI
 * shows for a given department:
 *   - total tickets currently in the department, open count, members count
 *   - tickets worked in the last 7 days (user_worked_on_tickets)
 *   - user-wise ticket breakdown per queue member
 *   - tickets created vs resolved, this week vs last week (fixed 7-day windows)
 *   - per-member workload, this week vs last week
 *
 * One thing this script deliberately does NOT reproduce: the SLA
 * breached/due counts. Those come from computeSLAInstancesPure, a fairly
 * involved piece of TS logic (goal durations per priority, dept SLA
 * pause/resume bookkeeping, waivers, jira_sla_breached history) that isn't
 * worth re-implementing in raw SQL just for a spot check -- and re-
 * implementing it here badly would risk becoming exactly the kind of
 * "simpler dueDate proxy" the real endpoint was specifically written to
 * avoid. Verify those two numbers directly against the running app/UI
 * instead of against this script.
 *
 * Usage: DATABASE_URL=... node report-queue-dashboard.mjs "Migration"
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const dept = process.argv[2];
if (!dept) {
  console.error('Usage: node report-queue-dashboard.mjs <department-name>   (e.g. "Migration" or "Dev")');
  process.exit(1);
}

async function main() {
  console.log(`========== Queue Dashboard sanity check: "${dept}" ==========\n`);

  // Members -- same exact-name, case-insensitive match across every space's
  // custom_queues row the real endpoint uses (never trust a hardcoded list).
  const cq = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  const memberIds = new Set();
  const spaceKeys = new Set();
  for (const row of cq.rows) {
    for (const q of row.queues || []) {
      if ((q.name || '').trim().toLowerCase() === dept.toLowerCase()) {
        (q.memberIds || []).forEach((id) => memberIds.add(id));
        spaceKeys.add(row.space_key);
      }
    }
  }
  console.log(`Matching custom_queues rows found in space(s): ${[...spaceKeys].join(', ') || '(none)'}`);
  console.log(`Members resolved: ${memberIds.size}`);
  const memberIdList = [...memberIds];

  let members = [];
  if (memberIdList.length) {
    const r = await pool.query(
      `SELECT id, email, "firstName", "lastName" FROM users WHERE id = ANY($1::text[])`,
      [memberIdList]
    );
    members = r.rows;
  }
  console.log(JSON.stringify(members.map((m) => ({ id: m.id, name: `${m.firstName || ''} ${m.lastName || ''}`.trim(), email: m.email })), null, 2));

  console.log('\n---------- Total / open ticket counts ----------');
  const totalRes = await pool.query(`SELECT COUNT(*)::int AS n FROM issues WHERE LOWER(current_department) = LOWER($1)`, [dept]);
  console.log(`Total tickets currently in "${dept}": ${totalRes.rows[0].n}`);

  const openRes = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
     WHERE LOWER(i.current_department) = LOWER($1) AND (s.category IS DISTINCT FROM 'done')`,
    [dept]
  );
  console.log(`Open (not-done) tickets: ${openRes.rows[0].n}`);

  console.log('\n---------- Tickets worked, last 7 days ----------');
  const workedRes = await pool.query(
    `SELECT COUNT(DISTINCT issue_id)::int AS n FROM user_worked_on_tickets
     WHERE LOWER(dept) = LOWER($1) AND worked_at >= NOW() - INTERVAL '7 days'`,
    [dept]
  );
  console.log(`Distinct tickets worked (last 7 days): ${workedRes.rows[0].n}`);

  console.log('\n---------- User-wise current ticket counts ----------');
  if (memberIdList.length) {
    const userWiseRes = await pool.query(
      `SELECT "assigneeId", COUNT(*)::int AS cnt FROM issues
       WHERE LOWER(current_department) = LOWER($1) AND "assigneeId" = ANY($2::text[])
       GROUP BY "assigneeId" ORDER BY cnt DESC`,
      [dept, memberIdList]
    );
    const byId = Object.fromEntries(userWiseRes.rows.map((r) => [r.assigneeId, r.cnt]));
    for (const m of members) {
      console.log(`  ${`${m.firstName || ''} ${m.lastName || ''}`.trim() || m.email}: ${byId[m.id] || 0}`);
    }
  } else {
    console.log('  (no members resolved -- nothing to break down)');
  }

  console.log('\n---------- Created vs resolved, week over week ----------');
  const createdRes = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL '7 days')::int AS this_week,
       COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL '14 days' AND "createdAt" < NOW() - INTERVAL '7 days')::int AS last_week
     FROM issues WHERE LOWER(current_department) = LOWER($1)`,
    [dept]
  );
  const resolvedRes = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE "resolvedAt" >= NOW() - INTERVAL '7 days')::int AS this_week,
       COUNT(*) FILTER (WHERE "resolvedAt" >= NOW() - INTERVAL '14 days' AND "resolvedAt" < NOW() - INTERVAL '7 days')::int AS last_week
     FROM issues WHERE LOWER(current_department) = LOWER($1) AND "resolvedAt" IS NOT NULL`,
    [dept]
  );
  console.log(`Created -- last week: ${createdRes.rows[0].last_week}, this week: ${createdRes.rows[0].this_week}`);
  console.log(`Resolved -- last week: ${resolvedRes.rows[0].last_week}, this week: ${resolvedRes.rows[0].this_week}`);

  console.log('\n---------- Per-member workload, week over week ----------');
  if (memberIdList.length) {
    const workloadRes = await pool.query(
      `SELECT user_id,
         COUNT(DISTINCT issue_id) FILTER (WHERE worked_at >= NOW() - INTERVAL '7 days')::int AS this_week,
         COUNT(DISTINCT issue_id) FILTER (WHERE worked_at >= NOW() - INTERVAL '14 days' AND worked_at < NOW() - INTERVAL '7 days')::int AS last_week
       FROM user_worked_on_tickets
       WHERE LOWER(dept) = LOWER($1) AND user_id = ANY($2::text[])
       GROUP BY user_id`,
      [dept, memberIdList]
    );
    const byId = Object.fromEntries(workloadRes.rows.map((r) => [r.user_id, r]));
    for (const m of members) {
      const w = byId[m.id] || { last_week: 0, this_week: 0 };
      console.log(`  ${`${m.firstName || ''} ${m.lastName || ''}`.trim() || m.email}: last week ${w.last_week}, this week ${w.this_week}`);
    }
  } else {
    console.log('  (no members resolved -- nothing to break down)');
  }

  console.log('\n---------- NOT checked here -- verify against the live app ----------');
  console.log('SLA breached count and Due tickets count (computeSLAInstancesPure-based). See file header comment.');

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
