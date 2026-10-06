// Checks custom_queues.queues[Migration].slaPolicies -- a separate,
// denormalized copy of SLA config used as a Settings-page fallback/
// display source -- to see what value it shows for Highest priority,
// in case it differs from the sla_definitions row (which has 0h,
// confirmed wrong) and reflects what was actually intended/entered in
// the Queue Settings UI. Read-only.
//
// Usage: node check-queue-settings-sla.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT space_key, queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = rows[0]?.queues || [];
  const migration = queues.find(q => q.name === 'Migration');
  console.log('Migration queue slaPolicies:', JSON.stringify(migration?.slaPolicies, null, 2));
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
