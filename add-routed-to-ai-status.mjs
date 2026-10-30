// One-time write: add a "Routed to AI" status to Dev/QA/Infra/Migration's
// own queueStatuses lists. The Routed-to-X auto-move-to-that-queue
// mechanism already works for any queue status named that way (confirmed
// working elsewhere in this app) -- this just adds the status itself.
// Skips any queue that already has a "Routed to AI" entry, so it's safe
// to re-run.
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
    const qs = queues[idx].queueStatuses || [];
    const already = qs.some((s) => (s.name || '').toLowerCase() === 'routed to ai');
    if (already) { console.log(`"${name}": already has "Routed to AI", skipping`); continue; }
    const newStatus = {
      id: `qst_${name.toLowerCase()}_waitingai`,
      name: 'Routed to AI',
      color: '#8b5cf6',
      category: 'in_progress',
      order: qs.length,
    };
    queues[idx] = { ...queues[idx], queueStatuses: [...qs, newStatus] };
    changed = true;
    console.log(`"${name}": added "Routed to AI" (id=${newStatus.id})`);
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
