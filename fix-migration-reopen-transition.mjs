// User request: once a Migration ticket is Resolved, the status dropdown
// should offer ONLY "Reopen" (labeled as an action, not the raw status
// name) and picking it moves the ticket to "In Progress" -- nothing else
// selectable from Resolved. Currently Migration's queueTransitions allow
// Resolved -> Open AND Resolved -> Routed to QA, with no naming. Replacing
// both with a single Resolved -> In Progress transition named "Reopen".
// The frontend (issue detail page's status dropdown, and the board table's
// inline one) already shows a transition's own `name` as the primary
// label when set, falling back to the destination status's name otherwise
// -- this is a pure data change, no other queue's transitions are touched.
//
// Dry-run by default. Pass --apply to actually write.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = rows[0]?.queues || [];
  const migration = queues.find(q => (q.name || '').toLowerCase() === 'migration');
  if (!migration) { console.log('Migration queue not found'); await pool.end(); return; }

  console.log('Current Migration queueTransitions:');
  console.log(JSON.stringify(migration.queueTransitions, null, 2));

  const resolvedId = migration.queueStatuses.find(s => s.name.toLowerCase() === 'resolved')?.id;
  const inProgressId = migration.queueStatuses.find(s => s.name.toLowerCase() === 'in progress')?.id;
  if (!resolvedId || !inProgressId) { console.log('Could not find Resolved/In Progress status ids'); await pool.end(); return; }

  const otherTransitions = (migration.queueTransitions || []).filter(t => t.from !== resolvedId);
  const newTransitions = [
    ...otherTransitions,
    { from: resolvedId, to: inProgressId, name: 'Reopen' },
  ];

  console.log('\nNew Migration queueTransitions would be:');
  console.log(JSON.stringify(newTransitions, null, 2));

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to write this change.');
    await pool.end();
    return;
  }

  const updatedQueues = queues.map(q => q.id === migration.id ? { ...q, queueTransitions: newTransitions } : q);
  await pool.query(
    `UPDATE custom_queues SET queues = $1, updated_at = NOW() WHERE space_key = 'TESTIN'`,
    [JSON.stringify(updatedQueues)]
  );
  console.log('\nApplied.');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
