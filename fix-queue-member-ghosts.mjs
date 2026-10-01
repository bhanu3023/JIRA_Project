// Removes memberIds from a queue's config that don't resolve to any real
// user (confirmed via check-queue-member-ghosts.mjs -- 8 of 38 on the Dev
// queue in TESTIN/CloudFuze Board don't match any users row at all, which
// is why the sidebar count and the table count disagreed: 38 vs 30). Only
// removes IDs proven to not exist; every real member stays untouched.
//
// Usage:
//   node fix-queue-member-ghosts.mjs <spaceKey> <queueId>           # dry run
//   node fix-queue-member-ghosts.mjs <spaceKey> <queueId> --apply   # writes the fix

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const SPACE_KEY = process.argv[2];
const QUEUE_ID = process.argv[3];

if (!SPACE_KEY || !QUEUE_ID) {
  console.error('Usage: node fix-queue-member-ghosts.mjs <spaceKey> <queueId> [--apply]');
  process.exit(1);
}

async function main() {
  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY.toUpperCase()]);
  if (!cqRows.length) { console.log('No custom_queues row for this space'); await pool.end(); return; }
  const queues = cqRows[0].queues || [];
  const queueIdx = queues.findIndex((q) => q.id === QUEUE_ID);
  if (queueIdx === -1) { console.log(`Queue ${QUEUE_ID} not found`); await pool.end(); return; }
  const queue = queues[queueIdx];
  const memberIds = queue.memberIds || [];

  const { rows: realUsers } = await pool.query(`SELECT id FROM users WHERE id = ANY($1::text[])`, [memberIds]);
  const realIds = new Set(realUsers.map(u => u.id));
  const ghosts = memberIds.filter((id) => !realIds.has(id));
  const kept = memberIds.filter((id) => realIds.has(id));

  console.log(`Queue "${queue.name}": ${memberIds.length} configured, ${kept.length} real, ${ghosts.length} ghost(s) to remove:`);
  for (const g of ghosts) console.log(`  ${g}`);

  if (!ghosts.length) { console.log('\nNothing to fix.'); await pool.end(); return; }

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to remove these ${ghosts.length} ghost ID(s), leaving ${kept.length} real members.`);
    await pool.end();
    return;
  }

  queues[queueIdx] = { ...queue, memberIds: kept };
  await pool.query(`UPDATE custom_queues SET queues = $1::jsonb, updated_at = NOW() WHERE space_key = $2`, [JSON.stringify(queues), SPACE_KEY.toUpperCase()]);
  console.log(`\nUpdated. Queue "${queue.name}" now has ${kept.length} memberIds (was ${memberIds.length}).`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
