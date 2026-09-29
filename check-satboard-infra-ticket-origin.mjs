// SAT_Board (a "service_desk" type space, like IT ADMINISTRATION) has a
// custom "Infra" queue configured with 0 members and exactly 1 ticket in
// that department -- the Queues overview page is correctly showing what's
// really in the DB, not a display bug. The real question is where this
// one stray queue/ticket came from and whether SAT_Board was ever meant
// to have department queues at all. Finding the actual ticket and its
// origin/history before suggesting any change.
//
// Read-only.
//
// Usage: node check-satboard-infra-ticket-origin.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = 'SB'`);
  const spaceId = spaceRows[0]?.id;

  const { rows: ticket } = await pool.query(
    `SELECT id, key, cf_key, summary, current_department, original_dept, "createdAt", "updatedAt",
            jira_source_key, "reporterId"
     FROM issues WHERE "spaceId" = $1 AND current_department = 'Infra'`,
    [spaceId]
  );
  console.log('The one Infra-department ticket in SAT_Board:');
  for (const t of ticket) {
    console.log(JSON.stringify(t, null, 2));
  }

  if (ticket[0]) {
    const { rows: hist } = await pool.query(
      `SELECT field, "oldValue", "newValue", "authorName", "createdAt" FROM issue_history WHERE "issueId" = $1 ORDER BY "createdAt" ASC`,
      [ticket[0].id]
    );
    console.log('\nFull history of that ticket:');
    for (const h of hist) console.log(`  [${h.field}] ${h.createdAt.toISOString()} by ${h.authorName}: "${h.oldValue}" -> "${h.newValue}"`);
  }

  // Every other space's own custom_queues, for comparison -- is SAT_Board
  // the odd one out, or do other service_desk-type spaces also have a
  // similar single stray queue?
  const { rows: allQueues } = await pool.query(
    `SELECT sp.key, sp.type, cq.queues FROM spaces sp LEFT JOIN custom_queues cq ON cq.space_key = sp.key ORDER BY sp.key`
  );
  console.log('\nAll spaces and their configured queues:');
  for (const s of allQueues) {
    const names = (s.queues || []).map((q) => q.name);
    console.log(`  ${s.key} (type=${s.type}): ${names.length ? names.join(', ') : 'none'}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
