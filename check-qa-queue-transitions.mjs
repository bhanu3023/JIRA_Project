// The ticket detail page's status dropdown, for a queue-scoped ticket,
// actually pulls its statuses/transitions from custom_queues.queues[QA]'s
// own queueStatuses/queueTransitions JSONB fields -- NOT the global
// workflow_transitions table (which is why checking that table found
// nothing). Pulls the real QA queue config to see whether a transition
// from QA's "In Progress" queue-status to its "Resolved" queue-status
// actually exists.
//
// Read-only.
//
// Usage: node check-qa-queue-transitions.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  for (const row of rows) {
    const queues = Array.isArray(row.queues) ? row.queues : [];
    for (const q of queues) {
      if (String(q?.name || '').toLowerCase() !== 'qa') continue;
      console.log(`Space: ${row.space_key}  Queue: ${q.name}  id=${q.id}`);
      console.log('\nqueueStatuses (with real ids):');
      for (const s of (q.queueStatuses || [])) console.log(`  id=${s.id}  name=${s.name}  category=${s.category}`);
      console.log('\nqueueTransitions:');
      const transitions = q.queueTransitions || [];
      if (!transitions.length) console.log('  (EMPTY -- no transitions configured for this queue at all)');
      for (const t of transitions) {
        const from = (q.queueStatuses || []).find((s) => s.id === (t.fromStatusId ?? t.from));
        const to = (q.queueStatuses || []).find((s) => s.id === (t.toStatusId ?? t.to));
        console.log(`  ${from?.name || t.fromStatusId || t.from} -> ${to?.name || t.toStatusId || t.to}`);
      }

      const inProgress = (q.queueStatuses || []).find((s) => (s.name || '').toLowerCase() === 'in progress');
      const resolved = (q.queueStatuses || []).find((s) => (s.name || '').toLowerCase() === 'resolved');
      console.log(`\n"In Progress" queue-status id: ${inProgress?.id}`);
      console.log(`"Resolved" queue-status id: ${resolved?.id}`);
      const hasTransition = transitions.some((t) =>
        (t.fromStatusId ?? t.from) === inProgress?.id && (t.toStatusId ?? t.to) === resolved?.id
      );
      console.log(`Transition In Progress -> Resolved exists: ${hasTransition ? 'YES' : 'NO -- this is the bug'}`);
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
