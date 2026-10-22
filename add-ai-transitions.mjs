// One-time write: for Dev/QA/Infra/Migration, add bidirectional
// transitions between "Routed to AI" (already added as a status) and
// every OTHER status already in that queue -- matching the complete
// from-every-status-to-every-other-status mesh already set up for the
// other statuses (confirmed via check-queue-transitions.mjs). The issue
// detail page's status dropdown only offers a status as a destination
// when an explicit transition exists for the ticket's current status --
// the status alone (queueStatuses) isn't enough. Only ADDS missing pairs
// involving "Routed to AI"; every existing transition (including any
// unrelated/custom ones) is left untouched. Safe to re-run.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';
const TARGET_QUEUES = ['Dev', 'QA', 'Infra', 'Migration'];

async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = rows[0]?.queues || [];
  let changed = false;

  for (const name of TARGET_QUEUES) {
    const idx = queues.findIndex((qq) => (qq.name || '').toLowerCase() === name.toLowerCase());
    if (idx === -1) { console.log(`"${name}": not found, skipping`); continue; }
    const q = queues[idx];
    const statuses = q.queueStatuses || [];
    const aiStatus = statuses.find((s) => (s.name || '').toLowerCase() === 'routed to ai');
    if (!aiStatus) { console.log(`"${name}": no "Routed to AI" status found -- run add-routed-to-ai-status.mjs first`); continue; }
    const others = statuses.filter((s) => s.id !== aiStatus.id);

    const transitions = q.queueTransitions || [];
    const pairKey = (from, to) => `${from}=>${to}`;
    const existingPairs = new Set(
      transitions.map((t) => pairKey(t.fromStatusId ?? t.from, t.toStatusId ?? t.to))
    );

    const toAdd = [];
    for (const other of others) {
      const fwd = pairKey(other.id, aiStatus.id);
      const back = pairKey(aiStatus.id, other.id);
      if (!existingPairs.has(fwd)) { toAdd.push({ fromStatusId: other.id, toStatusId: aiStatus.id }); existingPairs.add(fwd); }
      if (!existingPairs.has(back)) { toAdd.push({ fromStatusId: aiStatus.id, toStatusId: other.id }); existingPairs.add(back); }
    }

    if (toAdd.length === 0) { console.log(`"${name}": already fully connected to Routed to AI, skipping`); continue; }

    queues[idx] = { ...q, queueTransitions: [...transitions, ...toAdd] };
    changed = true;
    console.log(`"${name}": added ${toAdd.length} transitions connecting "Routed to AI" with ${others.length} other statuses`);
  }

  if (changed) {
    await pool.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [JSON.stringify(queues), SPACE_KEY]);
    console.log('\nSaved.');
  } else {
    console.log('\nNothing to change.');
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
