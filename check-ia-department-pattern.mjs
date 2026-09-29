// CF-33655 (SAT_Board) still shows "Infra" on its SLA card because I
// deliberately left the TICKET untouched when removing the queue config --
// current_department is a separate field on the issue row, not derived
// from custom_queues. Now that SAT_Board isn't meant to have an Infra
// queue at all, this ticket is the odd one out. Checking how
// IT ADMINISTRATION (a plain service_desk board with zero configured
// queues, same as SAT_Board is now) sets current_department on its own
// tickets, to find the right value to move CF-33655 to instead of
// guessing.
//
// Read-only.
//
// Usage: node check-ia-department-pattern.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id, key FROM spaces WHERE key = 'IA'`);
  const iaId = spaceRows[0]?.id;
  console.log(`IT ADMINISTRATION space id: ${iaId}`);

  const { rows: deptCounts } = await pool.query(
    `SELECT current_department, COUNT(*) FROM issues WHERE "spaceId" = $1 GROUP BY current_department ORDER BY COUNT(*) DESC`,
    [iaId]
  );
  console.log('\ncurrent_department values used in IT ADMINISTRATION tickets:');
  for (const r of deptCounts) console.log(`  "${r.current_department}": ${r.count}`);

  // Same for CF-33655 itself, plus its department history (already saw
  // this once, but re-confirming the exact current state before touching it)
  const { rows: ticket } = await pool.query(
    `SELECT id, key, current_department, original_dept, "statusId", s.name AS status_name
     FROM issues i LEFT JOIN statuses s ON s.id = i."statusId" WHERE key = 'CF-33655'`
  );
  console.log('\nCF-33655 now:', JSON.stringify(ticket[0]));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
