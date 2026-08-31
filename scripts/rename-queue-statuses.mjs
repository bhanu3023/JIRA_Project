// One-time rename: "Waiting for X" -> "Routed to X" in a given queue's own
// queueStatuses config, keeping id/color/order/category unchanged. Safe only
// once the "Routed to X" regex support for auto department-handoff is
// deployed -- otherwise the handoff would stop firing for these statuses.
// Generic version of the Migration-specific script -- derives each rename
// from the status's own current name instead of a hardcoded department list,
// so the same script covers Dev, QA, Infra, or any other queue.
//
// Queue names aren't unique across spaces (e.g. two separate "Infra" queues
// exist in different spaces) -- pass --space=<spaceKey> to scope to one
// specific space's queue when that matters, otherwise every space with a
// matching queue name gets updated (each in its own UPDATE, not just the
// last one found -- an earlier version of this script only kept the LAST
// match across all spaces, silently skipping every other one).
//
// Usage: node scripts/rename-queue-statuses.mjs --queue=Dev [--space=TESTIN] [--dry-run]

import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');
const queueArg = (process.argv.find((a) => a.startsWith('--queue=')) || '').split('=')[1];
const spaceArg = (process.argv.find((a) => a.startsWith('--space=')) || '').split('=')[1];
if (!queueArg) {
  console.error('Usage: node scripts/rename-queue-statuses.mjs --queue=<QueueName> [--space=<spaceKey>] [--dry-run]');
  process.exit(1);
}

function renameStatus(name) {
  const m = String(name || '').match(/^waiting\s+for\s+(.+)$/i);
  return m ? `Routed to ${m[1].trim()}` : null;
}

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;
  const client = new pg.Client({ connectionString });
  await client.connect();

  const { rows } = await client.query(`SELECT space_key, queues FROM custom_queues`);
  const toUpdate = [];
  for (const row of rows) {
    if (spaceArg && row.space_key.toUpperCase() !== spaceArg.toUpperCase()) continue;
    const queues = row.queues || [];
    const idx = queues.findIndex((q) => (q.name || '').toLowerCase() === queueArg.toLowerCase());
    if (idx === -1) continue;
    const queue = queues[idx];
    const statuses = queue.queueStatuses || [];
    let changed = false;
    const newStatuses = statuses.map((s) => {
      const renamed = renameStatus(s.name);
      if (renamed && s.name !== renamed) {
        changed = true;
        console.log(`  ${row.space_key} / ${queue.name} (${queue.id}): "${s.name}" -> "${renamed}" (id=${s.id})`);
        return { ...s, name: renamed };
      }
      return s;
    });
    if (changed) {
      queues[idx] = { ...queue, queueStatuses: newStatuses };
      toUpdate.push({ spaceKey: row.space_key, queues });
    }
  }

  if (!toUpdate.length) {
    console.log(`No "${queueArg}" queue${spaceArg ? ` in space ${spaceArg}` : ''} found needing renaming (already renamed, or none exists).`);
    await client.end();
    return;
  }

  if (DRY_RUN) {
    console.log(`\nDry run only -- nothing written. ${toUpdate.length} space(s) would be updated. Re-run without --dry-run to apply.`);
    await client.end();
    return;
  }

  for (const u of toUpdate) {
    await client.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [
      JSON.stringify(u.queues),
      u.spaceKey,
    ]);
    console.log(`Updated custom_queues for space ${u.spaceKey}.`);
  }
  await client.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
