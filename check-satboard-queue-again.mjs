// Read-only: SAT_Board's "Create" ticket dialog is showing a required Queue
// field pre-filled/forced to "Infra" again, even though the stray Infra
// queue entry in custom_queues (space_key='SB') was already removed earlier
// this engagement. Check the CURRENT state of custom_queues for SB, and
// whether anything else (sla_definitions scoped to SB, a hardcoded
// frontend fallback) could be the real source.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: cq } = await pool.query(`SELECT space_key, queues FROM custom_queues WHERE space_key = 'SB'`);
  console.log('custom_queues for SB (SAT_Board):', JSON.stringify(cq, null, 2));

  const { rows: space } = await pool.query(`SELECT id, key, name FROM spaces WHERE key = 'SB'`);
  console.log('\nSpace row:', space[0]);
  if (space[0]) {
    const { rows: sla } = await pool.query(`SELECT id, name, dept_name, status FROM sla_definitions WHERE "spaceId" = $1`, [space[0].id]);
    console.log('SLA definitions scoped to SAT_Board:', JSON.stringify(sla, null, 2));
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
