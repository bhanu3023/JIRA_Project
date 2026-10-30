// Migration's queueTransitions was nearly empty before (1 entry), so its
// status dropdown relied on the "no transitions for this status -> show
// everything" fallback. add-ai-transitions.mjs added explicit transitions
// INTO/OUT OF "Routed to AI" only, which switched Migration out of that
// fallback for any status now connected to AI -- "In Progress" (the
// reported case) now has exactly one explicit transition (-> Routed to
// AI), so the dropdown shows ONLY that instead of falling back to
// everything. Dev/QA/Infra were unaffected since they already had a
// complete mesh before AI was added. Fix: build Migration's own complete
// mesh (every status <-> every other status), matching Dev/QA/Infra's
// existing pattern, merging with (not replacing) whatever's already
// there. Safe to re-run.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';
const QUEUE_NAME = 'Migration';

async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = rows[0]?.queues || [];
  const idx = queues.findIndex((qq) => (qq.name || '').toLowerCase() === QUEUE_NAME.toLowerCase());
  if (idx === -1) { console.error(`"${QUEUE_NAME}" not found`); process.exit(1); }

  const q = queues[idx];
  const statuses = q.queueStatuses || [];
  const transitions = q.queueTransitions || [];
  const pairKey = (from, to) => `${from}=>${to}`;
  const existingPairs = new Set(transitions.map((t) => pairKey(t.fromStatusId ?? t.from, t.toStatusId ?? t.to)));

  const toAdd = [];
  for (const a of statuses) {
    for (const b of statuses) {
      if (a.id === b.id) continue;
      const key = pairKey(a.id, b.id);
      if (!existingPairs.has(key)) {
        toAdd.push({ fromStatusId: a.id, toStatusId: b.id });
        existingPairs.add(key);
      }
    }
  }

  if (toAdd.length === 0) {
    console.log(`"${QUEUE_NAME}" already has a complete mesh (${transitions.length} transitions). Nothing to change.`);
    await pool.end();
    return;
  }

  queues[idx] = { ...q, queueTransitions: [...transitions, ...toAdd] };
  await pool.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [JSON.stringify(queues), SPACE_KEY]);
  console.log(`"${QUEUE_NAME}": added ${toAdd.length} missing transitions to complete the mesh across ${statuses.length} statuses (${statuses.map((s) => s.name).join(', ')}).`);
  console.log(`Total transitions now: ${transitions.length + toAdd.length}`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
