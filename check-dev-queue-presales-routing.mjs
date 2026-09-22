// CF-33303 (Dev department) shows "Routed to Dev/Infra/Migration" in its
// status dropdown but no "Routed to Pre-sales" option. The dropdown is
// built from the queue's own queueStatuses/queueTransitions config in
// custom_queues (TESTIN space), not a hardcoded list -- likely Dev's queue
// config just never had a Pre-sales routing status/transition added.
// Dumps Dev's real queueStatuses/queueTransitions to confirm.
//
// Read-only.
//
// Usage: node check-dev-queue-presales-routing.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT space_key, queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = rows[0]?.queues || [];
  const dev = queues.find((q) => (q.name || '').toLowerCase() === 'dev');
  if (!dev) { console.log('Dev queue not found'); await pool.end(); return; }

  console.log(`Dev queue id: ${dev.id}`);
  console.log('\nqueueStatuses:');
  for (const s of (dev.queueStatuses || [])) console.log(`  id=${s.id} name="${s.name}" category=${s.category} color=${s.color} order=${s.order}`);

  console.log('\nqueueTransitions (count):', (dev.queueTransitions || []).length);
  const routedToNames = new Set((dev.queueStatuses || []).filter(s => /^(routed to|waiting for)/i.test(s.name || '')).map(s => s.name));
  console.log('Existing "Routed to X" statuses:', Array.from(routedToNames));

  console.log('\n\n=== For comparison, Migration queue\'s own queueStatuses (to see the exact shape a "Routed to Pre-sales" entry should mirror) ===');
  const migration = queues.find((q) => (q.name || '').toLowerCase() === 'migration');
  if (migration) {
    for (const s of (migration.queueStatuses || [])) console.log(`  id=${s.id} name="${s.name}" category=${s.category} color=${s.color} order=${s.order}`);
  }

  console.log('\n\n=== Pre-Sales queue\'s own id/name (for the target of the new transition) ===');
  const preSales = queues.find((q) => /pre.?sales/i.test(q.name || ''));
  console.log(preSales ? `id=${preSales.id} name="${preSales.name}"` : 'NOT FOUND');

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
