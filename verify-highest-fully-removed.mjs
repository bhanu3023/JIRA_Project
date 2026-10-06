// Final verification: confirm zero tickets still have priority=highest,
// and zero SLA policies (sla_definitions or custom_queues denormalized
// copy) still have a "highest" priorityRow anywhere. Read-only.
//
// Usage: node verify-highest-fully-removed.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: ticketCount } = await pool.query(`SELECT COUNT(*)::int AS cnt FROM issues WHERE LOWER(priority) = 'highest'`);
  console.log(`Tickets still with priority=highest: ${ticketCount[0].cnt} (should be 0)`);

  const { rows: policies } = await pool.query(`SELECT id, name, dept_name, goals FROM sla_definitions`);
  let leftoverPolicies = 0;
  for (const p of policies) {
    for (const g of (p.goals || [])) {
      if (g.isPriorityGroup && Array.isArray(g.priorityRows)) {
        if (g.priorityRows.some(r => r.priority?.toLowerCase() === 'highest')) {
          leftoverPolicies++;
          console.log(`  STILL has highest row: [${p.dept_name || 'space-wide'}] "${p.name}" (${p.id})`);
        }
      }
    }
  }
  console.log(`SLA policies still with a highest row: ${leftoverPolicies} (should be 0)`);

  const { rows: cqRows } = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  let leftoverCq = 0;
  for (const row of cqRows) {
    for (const q of (row.queues || [])) {
      for (const policy of (q.slaPolicies || [])) {
        if ((policy.goals || []).some(g => g.priority?.toLowerCase() === 'highest')) {
          leftoverCq++;
          console.log(`  STILL has highest in custom_queues: space=${row.space_key} queue=${q.name}`);
        }
      }
    }
  }
  console.log(`custom_queues entries still with highest: ${leftoverCq} (should be 0)`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
