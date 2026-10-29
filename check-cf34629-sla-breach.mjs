// Read-only: verify CF-34629's QA and Infra "BREACHED HERE" cards against
// the raw dept_sla_log data -- the panel shows DUE time earlier than START
// time for both, which looks like a bug but may just be the documented
// "not clamped to 0" dueTime math for a dept that was already over its goal
// when frozen. Confirm the real elapsed-vs-goal numbers directly.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT COALESCE(cf_key,key) AS key, current_department, priority, dept_sla_log, dept_assignees, "assigneeId"
    FROM issues WHERE cf_key = 'CF-34629' OR key = 'CF-34629'
  `);
  const row = rows[0];
  console.log('current_department:', row.current_department, '| priority:', row.priority);
  console.log('\nRaw dept_sla_log:');
  console.log(JSON.stringify(row.dept_sla_log, null, 2));
  console.log('\ndept_assignees:', JSON.stringify(row.dept_assignees, null, 2));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
