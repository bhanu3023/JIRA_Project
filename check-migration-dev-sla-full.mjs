// Full audit of Migration AND Dev's current live SLA policies (every
// priority tier, every policy) to check for other misconfigured
// values (0, missing, obviously backwards) beyond the one already
// found (Migration Highest = 0h). Read-only.
//
// Usage: node check-migration-dev-sla-full.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT id, name, dept_name, goals, status
    FROM sla_definitions
    WHERE LOWER(dept_name) IN ('migration', 'dev')
    ORDER BY dept_name, status DESC, name
  `);
  for (const r of rows) {
    console.log(`\n[${r.dept_name}] "${r.name}" (id=${r.id}, status=${r.status})`);
    for (const goal of (r.goals || [])) {
      if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
        for (const row of goal.priorityRows) {
          const flag = (row.timeValue === '0' || row.timeValue === 0 || !row.timeValue) ? '  <-- ZERO/MISSING' : '';
          console.log(`  ${row.priority}: ${row.timeValue} ${row.timeUnit}${flag}`);
        }
      } else if (goal.timeValue !== undefined) {
        console.log(`  (single goal, no priority breakdown): ${goal.timeValue} ${goal.timeUnit}`);
      }
    }
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
