// Deletes the stray "Infra" queue entry from SAT_Board's custom_queues row
// (0 members, never a real queue -- SAT_Board has no department/queue
// concept, same as IA). Dry-run by default -- pass --apply to write.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
async function main() {
  const { rows } = await pool.query(`SELECT space_key, queues FROM custom_queues WHERE space_key = 'SB'`);
  if (!rows.length) { console.log('No custom_queues row for SB -- nothing to do.'); await pool.end(); return; }
  console.log('Current queues for SB:', JSON.stringify(rows[0].queues, null, 2));
  if (!APPLY) { console.log('\nDry run only -- rerun with --apply to clear it.'); await pool.end(); return; }
  await pool.query(`UPDATE custom_queues SET queues = '[]'::jsonb WHERE space_key = 'SB'`);
  console.log('Cleared SB queues.');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
