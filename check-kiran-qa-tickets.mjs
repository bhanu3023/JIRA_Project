// Queue: QA + Assignee: Kiran U + Created/Updated 2026-02-01..2026-03-31
// shows 0 issues on the Filters page, but user says these are migrated
// Jira tickets that should be there. Checking: does Kiran have ANY QA
// tickets at all, what are their real createdAt/updatedAt values (Jira
// imports sometimes stamp createdAt at IMPORT time rather than
// preserving the original Jira date), and does current_department
// actually say QA for them. Read-only.
//
// Usage: node check-kiran-qa-tickets.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: kiranRows } = await pool.query(
    `SELECT id, "firstName", "lastName", email FROM users WHERE "firstName" ILIKE 'Kiran' LIMIT 5`
  );
  console.log('Users matching "Kiran":', JSON.stringify(kiranRows, null, 2));
  if (!kiranRows.length) { await pool.end(); return; }

  for (const kiran of kiranRows) {
    const { rows: allTickets } = await pool.query(`
      SELECT COALESCE(cf_key, key) AS key, current_department, "createdAt", "updatedAt", jira_sla_start_at
      FROM issues
      WHERE "assigneeId" = $1
      ORDER BY "createdAt" ASC
    `, [kiran.id]);
    console.log(`\n--- ${kiran.firstName} ${kiran.lastName} (${kiran.id}): ${allTickets.length} tickets total (any dept, any date) ---`);
    const byDept = {};
    for (const t of allTickets) byDept[t.current_department || '(none)'] = (byDept[t.current_department || '(none)'] || 0) + 1;
    console.log('By department:', JSON.stringify(byDept));

    const qaTickets = allTickets.filter(t => (t.current_department || '').toLowerCase() === 'qa');
    console.log(`QA tickets: ${qaTickets.length}`);
    for (const t of qaTickets.slice(0, 10)) {
      console.log(`  ${t.key}: createdAt=${t.createdAt?.toISOString?.()} updatedAt=${t.updatedAt?.toISOString?.()} jira_sla_start_at=${t.jira_sla_start_at}`);
    }
    if (qaTickets.length > 10) console.log(`  ... and ${qaTickets.length - 10} more`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
