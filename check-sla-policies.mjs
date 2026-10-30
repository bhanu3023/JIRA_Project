// Read-only: dump every active SLA policy's dept_name + goals, and
// CF-34482's real statusId/category/dept_statuses, to find out exactly why
// the Dev-scoped verdict comes out "breached" when Dev's OWN dedicated
// policy (12h goal, 6.79h elapsed) clearly isn't. Prime suspect: a
// GENERIC (no dept_name) policy that also applies to Dev, whose shorter
// goal Dev's raw elapsed time happens to exceed -- even though the frozen
// sla_snapshot never actually evaluated that generic policy against Dev's
// stint (it only recorded it against Migration's).
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: polRows } = await pool.query(`SELECT id, name, status, dept_name, goals, "pauseStatuses" FROM sla_definitions WHERE status = 'active' ORDER BY name`);
  console.log('--- All active SLA policies ---');
  for (const p of polRows) {
    console.log(`\n${p.id} | "${p.name}" | dept_name="${p.dept_name}" | pauseStatuses=${JSON.stringify(p.pauseStatuses)}`);
    console.log('goals:', JSON.stringify(p.goals));
  }

  const { rows: issueRows } = await pool.query(
    `SELECT i.id, i.key, i.cf_key, i."statusId", s.name AS status_name, s.category AS status_category,
            i.dept_statuses, i.dept_sla_log, i.current_department
     FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
     WHERE i.cf_key = 'CF-34482' OR i.key = 'CF-34482'`
  );
  console.log('\n\n--- CF-34482 status info ---');
  console.log(issueRows[0]);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
