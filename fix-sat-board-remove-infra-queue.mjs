// Removes the stray "Infra" queue (id cq_1793283585540, 0 members) from
// SAT_Board's custom_queues row. Leaves the 1 ticket currently tagged
// current_department='Infra' in this space untouched, per explicit request.
//
// Defaults to DRY RUN. Pass --apply to actually write the change.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'SB'`);
  if (!rows.length) { console.log('No custom_queues row for space_key=SB.'); return; }
  const queues = rows[0].queues || [];
  console.log('Current queues:', JSON.stringify(queues, null, 2));

  const nextQueues = queues.filter((q) => !(q.id === 'cq_1793283585540' && String(q.name || '').toLowerCase() === 'infra'));
  if (nextQueues.length === queues.length) {
    console.log('\nNo matching "Infra" queue found to remove -- nothing to do.');
    await pool.end();
    return;
  }
  console.log('\nQueues after removal:', JSON.stringify(nextQueues, null, 2));

  if (!APPLY) {
    console.log('\nDRY RUN ONLY -- no changes written. Re-run with --apply to actually update.');
    await pool.end();
    return;
  }

  await pool.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = 'SB'`, [JSON.stringify(nextQueues)]);
  console.log('\nUpdated. SAT_Board no longer has the stray "Infra" queue.');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
