// One-time rename: "Waiting for Dev/Infra/QA" -> "Routed to Dev/Infra/QA" in
// the Migration queue's own queueStatuses config, keeping id/color/order/
// category unchanged. Safe only once the "Routed to X" regex support (see
// the same commit as this script) is deployed -- otherwise the auto
// department-handoff would stop firing for these statuses.
//
// Usage: node scripts/rename-migration-queue-statuses.mjs [--dry-run]

import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');
const RENAMES = {
  'waiting for dev': 'Routed to Dev',
  'waiting for infra': 'Routed to Infra',
  'waiting for qa': 'Routed to QA',
};

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;
  const client = new pg.Client({ connectionString });
  await client.connect();

  const { rows } = await client.query(`SELECT space_key, queues FROM custom_queues`);
  let updatedRow = null;
  for (const row of rows) {
    const queues = row.queues || [];
    const idx = queues.findIndex((q) => (q.name || '').toLowerCase() === 'migration');
    if (idx === -1) continue;
    const queue = queues[idx];
    const statuses = queue.queueStatuses || [];
    let changed = false;
    const newStatuses = statuses.map((s) => {
      const key = (s.name || '').trim().toLowerCase();
      if (RENAMES[key] && s.name !== RENAMES[key]) {
        changed = true;
        console.log(`  ${row.space_key}: "${s.name}" -> "${RENAMES[key]}" (id=${s.id})`);
        return { ...s, name: RENAMES[key] };
      }
      return s;
    });
    if (changed) {
      queues[idx] = { ...queue, queueStatuses: newStatuses };
      updatedRow = { spaceKey: row.space_key, queues };
    }
  }

  if (!updatedRow) {
    console.log('No Migration queue found needing renaming (already renamed, or none exists).');
    await client.end();
    return;
  }

  if (DRY_RUN) {
    console.log('\nDry run only -- nothing written. Re-run without --dry-run to apply.');
    await client.end();
    return;
  }

  await client.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [
    JSON.stringify(updatedRow.queues),
    updatedRow.spaceKey,
  ]);
  console.log(`\nUpdated custom_queues for space ${updatedRow.spaceKey}.`);
  await client.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
