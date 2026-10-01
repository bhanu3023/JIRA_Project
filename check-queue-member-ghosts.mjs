// Checks the real cause of a sidebar-vs-table member-count mismatch on a
// queue's People & Access page (e.g. "38 members" in the sidebar vs
// "Members 30" in the table) -- confirms whether queue.memberIds contains
// IDs that don't resolve to any real user record.
//
// Read-only.
//
// Usage: node check-queue-member-ghosts.mjs <spaceKey> <queueId>

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const [, , SPACE_KEY, QUEUE_ID] = process.argv;

if (!SPACE_KEY || !QUEUE_ID) {
  console.error('Usage: node check-queue-member-ghosts.mjs <spaceKey> <queueId>');
  process.exit(1);
}

async function main() {
  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY.toUpperCase()]);
  if (!cqRows.length) { console.log('No custom_queues row for this space'); await pool.end(); return; }
  const queues = cqRows[0].queues || [];
  const queue = queues.find((q) => q.id === QUEUE_ID);
  if (!queue) { console.log(`Queue ${QUEUE_ID} not found. Available: ${queues.map(q => q.id).join(', ')}`); await pool.end(); return; }

  const memberIds = queue.memberIds || [];
  console.log(`Queue "${queue.name}": ${memberIds.length} configured memberIds\n`);

  const { rows: realUsers } = await pool.query(
    `SELECT id, email, "firstName", "lastName", "isActive" FROM users WHERE id = ANY($1::text[])`,
    [memberIds]
  );
  const realIds = new Set(realUsers.map(u => u.id));
  const ghosts = memberIds.filter((id) => !realIds.has(id));
  const inactiveButReal = realUsers.filter(u => !u.isActive);

  console.log(`Resolve to a real user: ${realUsers.length}`);
  console.log(`Ghost IDs (no matching user at all): ${ghosts.length}`);
  for (const g of ghosts) console.log(`  ${g}`);
  console.log(`\nOf the real ones, INACTIVE (isActive=false): ${inactiveButReal.length}`);
  for (const u of inactiveButReal) console.log(`  ${u.email} (${u.firstName} ${u.lastName})`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
