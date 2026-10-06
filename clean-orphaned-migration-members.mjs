// Removes the 4 confirmed-orphaned member ids from TESTIN's Migration
// queue.memberIds (none resolve to a real `users` row, none are
// referenced as assigneeId/reporterId on any issue -- pure stale
// roster entries left over from a removed/renamed user). Dry-run by
// default; pass --apply to actually write.
//
// Usage: node clean-orphaned-migration-members.mjs [--apply]
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

const ORPHANED_IDS = new Set([
  'pg_8g68kcrard',
  'usr_pallavi_kosuvaripalli_cloudfuze_com',
  'usr_arundhati_sen_cloudfuze_com',
  'ar_99238a2f89449b526e269a64',
]);

async function main() {
  const { rows } = await pool.query(`SELECT space_key, queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  if (!rows.length) { console.log('No TESTIN custom_queues row found'); await pool.end(); return; }
  const queues = rows[0].queues;
  let changed = false;
  for (const q of queues) {
    if (String(q.name || '').toLowerCase() !== 'migration') continue;
    const before = q.memberIds || [];
    const after = before.filter((id) => !ORPHANED_IDS.has(id));
    console.log(`Migration queue.memberIds: ${before.length} -> ${after.length} (removing ${before.length - after.length})`);
    if (after.length !== before.length) {
      q.memberIds = after;
      changed = true;
    }
  }
  if (!changed) { console.log('Nothing to change'); await pool.end(); return; }

  if (APPLY) {
    await pool.query(`UPDATE custom_queues SET queues = $1 WHERE space_key = 'TESTIN'`, [JSON.stringify(queues)]);
    console.log('Applied.');
  } else {
    console.log('Dry run only -- re-run with --apply to write this change.');
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
