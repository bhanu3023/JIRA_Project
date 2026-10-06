// Check the "Pending with L2" status row itself -- is it marked deleted/
// archived/inactive, does it still show up in active status lists, and
// how many tickets (especially in Migration) still reference it. Read-only.
//
// Usage: node check-pending-l2-status.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT * FROM statuses WHERE id = 'status_pending_with_l2' OR LOWER(name) LIKE '%pending with l2%'`);
  console.log('statuses rows:', JSON.stringify(rows, null, 2));

  const { rows: usage } = await pool.query(`
    SELECT i.current_department, COUNT(*)::int AS cnt
    FROM issues i
    WHERE i."statusId" = 'status_pending_with_l2'
    GROUP BY i.current_department
    ORDER BY cnt DESC
  `);
  console.log('\nTickets currently using status_pending_with_l2, by department:');
  console.log(JSON.stringify(usage, null, 2));

  // Check custom_queues for any configured queueTransitions / dept status
  // lists that still reference it
  const { rows: cq } = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  for (const row of cq) {
    for (const q of (row.queues || [])) {
      const str = JSON.stringify(q);
      if (str.toLowerCase().includes('pending with l2') || str.toLowerCase().includes('pending_with_l2')) {
        console.log(`\n[${row.space_key}] queue "${q.name}" references "Pending with L2" in its config`);
      }
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
