// Scopes the "remove Highest priority everywhere" change: how many
// total tickets currently have priority='highest' (across every
// space/dept, not just Migration/Dev), and which SLA policies across
// the whole system have a "highest" priorityRow that would also need
// cleaning up. Read-only.
//
// Usage: node check-highest-priority-scope.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: byDept } = await pool.query(`
    SELECT current_department, COUNT(*)::int AS cnt
    FROM issues WHERE LOWER(priority) = 'highest'
    GROUP BY current_department ORDER BY cnt DESC
  `);
  console.log('Tickets with priority=highest, by current department:');
  console.log(JSON.stringify(byDept, null, 2));
  const total = byDept.reduce((s, r) => s + r.cnt, 0);
  console.log(`Total: ${total}`);

  const { rows: policies } = await pool.query(`
    SELECT id, name, dept_name, "spaceId", status, goals
    FROM sla_definitions
  `);
  console.log('\nSLA policies with a "highest" priorityRow:');
  for (const p of policies) {
    const goals = p.goals || [];
    for (const g of goals) {
      if (g.isPriorityGroup && Array.isArray(g.priorityRows)) {
        const row = g.priorityRows.find(r => r.priority?.toLowerCase() === 'highest');
        if (row) {
          console.log(`  [${p.dept_name || 'space-wide'}] "${p.name}" (id=${p.id}, status=${p.status}): highest=${row.timeValue} ${row.timeUnit}`);
        }
      }
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
