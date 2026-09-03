/**
 * fix-infra-transitions.mjs
 *
 * The Infra queue (space TESTIN) has a full list of statuses (Open, In
 * Progress, Routed to QA, Routed to Dev, Routed to Migration, Resolved) but
 * its queueTransitions array is completely empty -- so the "Move to status"
 * dropdown on an Infra ticket showed almost nothing regardless of which
 * statuses actually exist, since the UI reads allowed moves from
 * queueTransitions, not from the status list itself. Compare to the Dev
 * queue, which has a dense set of transitions connecting every non-resolved
 * status to every other, plus each to Resolved.
 *
 * This script, for the Infra queue only:
 *   1. Adds a "Routed to Pre-sales" status (Dev has it, Infra doesn't).
 *   2. Rebuilds queueTransitions as a full mesh: every non-resolved status
 *      can move to every other non-resolved status, and to Resolved.
 *
 * Usage:
 *   DATABASE_URL="..." node fix-infra-transitions.mjs           # dry run (default)
 *   DATABASE_URL="..." node fix-infra-transitions.mjs --apply   # actually writes
 */
import pg from 'pg';
const { Pool } = pg;

const APPLY = process.argv.includes('--apply');
const SPACE_KEY = 'TESTIN';
const QUEUE_NAME = 'Infra';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:neutara123@localhost:5433/neutara_db'
});

async function main() {
  const row = await pool.query(`SELECT space_key, queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  if (!row.rows[0]) {
    console.error(`No custom_queues row found for space_key=${SPACE_KEY}`);
    process.exit(1);
  }

  const queues = row.rows[0].queues;
  const infraIdx = queues.findIndex(q => q.name === QUEUE_NAME);
  if (infraIdx === -1) {
    console.error(`No queue named "${QUEUE_NAME}" found in space ${SPACE_KEY}`);
    process.exit(1);
  }

  const infra = queues[infraIdx];
  console.log(`Found "${QUEUE_NAME}" queue with ${infra.queueStatuses.length} statuses and ${(infra.queueTransitions || []).length} existing transitions.`);

  const statuses = [...infra.queueStatuses];
  const hasPresales = statuses.some(s => s.name.toLowerCase() === 'routed to pre-sales');
  if (!hasPresales) {
    const resolvedIdx = statuses.findIndex(s => s.category === 'done');
    const newStatus = {
      id: 'qst_infra_waitingpresales',
      name: 'Routed to Pre-sales',
      color: '#F59E0B',
      order: resolvedIdx === -1 ? statuses.length : resolvedIdx,
      category: 'in_progress',
    };
    if (resolvedIdx === -1) {
      statuses.push(newStatus);
    } else {
      statuses.splice(resolvedIdx, 0, newStatus);
      statuses[resolvedIdx + 1] = { ...statuses[resolvedIdx + 1], order: newStatus.order + 1 };
    }
    console.log(`Adding missing status: "Routed to Pre-sales" (id: ${newStatus.id})`);
  } else {
    console.log(`"Routed to Pre-sales" already exists, skipping status add.`);
  }

  const nonResolved = statuses.filter(s => s.category !== 'done');
  const resolved = statuses.filter(s => s.category === 'done');

  const transitions = [];
  for (const from of nonResolved) {
    for (const to of nonResolved) {
      if (from.id === to.id) continue;
      transitions.push({ name: '', fromStatusId: from.id, toStatusId: to.id });
    }
    for (const done of resolved) {
      transitions.push({ name: '', fromStatusId: from.id, toStatusId: done.id });
    }
  }
  console.log(`Built ${transitions.length} full-mesh transitions (${nonResolved.length} non-resolved statuses × each other, plus each → Resolved).`);

  const updatedInfra = { ...infra, queueStatuses: statuses, queueTransitions: transitions };
  const updatedQueues = [...queues];
  updatedQueues[infraIdx] = updatedInfra;

  if (!APPLY) {
    console.log('\n--- DRY RUN --- (pass --apply to write this)');
    console.log(JSON.stringify(updatedInfra, null, 2));
    return;
  }

  await pool.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [JSON.stringify(updatedQueues), SPACE_KEY]);
  console.log(`\nApplied: Infra queue in ${SPACE_KEY} now has ${statuses.length} statuses and ${transitions.length} transitions.`);
}

main().then(() => pool.end()).catch(e => { console.error(e); pool.end(); process.exit(1); });
