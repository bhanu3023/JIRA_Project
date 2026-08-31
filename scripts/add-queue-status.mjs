// One-time addition: adds a brand-new queueStatus entry to a given queue
// (e.g. "Routed to Migration" for QA and Infra, which never had a way to
// route directly to Migration before). Appends after the existing statuses,
// category 'in_progress', same color already used for every other "Routed
// to X" status in this system (#F59E0B) so it's visually consistent.
//
// Usage: node scripts/add-queue-status.mjs --queue=QA --space=TESTIN --name="Routed to Migration" [--dry-run]

import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');
const queueArg = (process.argv.find((a) => a.startsWith('--queue=')) || '').split('=')[1];
const spaceArg = (process.argv.find((a) => a.startsWith('--space=')) || '').split('=')[1];
const nameArg = (process.argv.find((a) => a.startsWith('--name=')) || '').split('=').slice(1).join('=');
if (!queueArg || !spaceArg || !nameArg) {
  console.error('Usage: node scripts/add-queue-status.mjs --queue=<QueueName> --space=<spaceKey> --name="<Status Name>" [--dry-run]');
  process.exit(1);
}

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;
  const client = new pg.Client({ connectionString });
  await client.connect();

  const { rows } = await client.query(`SELECT space_key, queues FROM custom_queues WHERE space_key = $1`, [spaceArg.toUpperCase()]);
  if (!rows.length) {
    console.log(`No custom_queues row for space ${spaceArg}.`);
    await client.end();
    return;
  }
  const row = rows[0];
  const queues = row.queues || [];
  const idx = queues.findIndex((q) => (q.name || '').toLowerCase() === queueArg.toLowerCase());
  if (idx === -1) {
    console.log(`No "${queueArg}" queue in space ${spaceArg}.`);
    await client.end();
    return;
  }
  const queue = queues[idx];
  const statuses = queue.queueStatuses || [];
  const alreadyExists = statuses.some((s) => (s.name || '').trim().toLowerCase() === nameArg.trim().toLowerCase());
  if (alreadyExists) {
    console.log(`"${nameArg}" already exists on ${spaceArg} / ${queue.name} -- nothing to do.`);
    await client.end();
    return;
  }
  const slug = nameArg.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const newStatus = {
    id: `qst_${queueArg.toLowerCase()}_${slug}`,
    name: nameArg,
    color: '#F59E0B',
    category: 'in_progress',
  };
  // Insert right before the first done-category status (e.g. "Resolved"),
  // not at the very end -- a routing option belongs grouped with the other
  // in-progress statuses, not trailing after the terminal one. Falls back
  // to appending at the end if there's no done-category status at all.
  const doneIdx = statuses.findIndex((s) => s.category === 'done');
  const insertAt = doneIdx === -1 ? statuses.length : doneIdx;
  const newStatuses = [...statuses.slice(0, insertAt), newStatus, ...statuses.slice(insertAt)]
    .map((s, i) => ({ ...s, order: i }));
  console.log(`Would add to ${spaceArg} / ${queue.name} at position ${insertAt}:`, JSON.stringify(newStatus, null, 2));
  console.log('Resulting order:', newStatuses.map((s) => s.name).join(' -> '));

  if (DRY_RUN) {
    console.log('\nDry run only -- nothing written. Re-run without --dry-run to apply.');
    await client.end();
    return;
  }

  queues[idx] = { ...queue, queueStatuses: newStatuses };
  await client.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [
    JSON.stringify(queues),
    row.space_key,
  ]);
  console.log(`\nUpdated custom_queues for space ${row.space_key}.`);
  await client.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
