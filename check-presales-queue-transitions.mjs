// Same class of issue already confirmed for QA: a queue-scoped ticket's
// status dropdown reads from custom_queues.queues[<dept>]'s own
// queueStatuses/queueTransitions JSONB fields, not the global
// workflow_transitions table. User reports Pre-Sales tickets that get
// routed elsewhere and come back don't show a "Resolved" option. Checks
// Pre-Sales' real queue config, plus CF-29995/CF-29994's actual current
// status, to confirm exactly what's missing.
//
// Read-only.
//
// Usage: node check-presales-queue-transitions.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = ['CF-29995', 'CF-29994'];

async function main() {
  const { rows } = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  for (const row of rows) {
    const queues = Array.isArray(row.queues) ? row.queues : [];
    for (const q of queues) {
      if (!/pre.?sales/i.test(String(q?.name || ''))) continue;
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
      const resolved = (q.queueStatuses || []).find((s) => (s.name || '').toLowerCase() === 'resolved');
      console.log(`\n"Resolved" queue-status id: ${resolved?.id || '(no Resolved status configured for this queue at all)'}`);
    }
  }

  console.log('\n=== Real current status for the 2 flagged tickets ===');
  for (const key of KEYS) {
    const { rows: r } = await pool.query(
      `SELECT i.key, i.cf_key, i.current_department, i."statusId", s.name AS status_name, s.category AS status_category
       FROM issues i LEFT JOIN statuses s ON i."statusId" = s.id
       WHERE i.cf_key = $1 OR i.key = $1`,
      [key]
    );
    if (!r.length) { console.log(`${key}: NOT FOUND`); continue; }
    console.log(`${key}: current_department=${r[0].current_department}  statusId=${r[0].statusId}  status=${r[0].status_name} (${r[0].status_category})`);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
