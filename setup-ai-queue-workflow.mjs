// One-time setup: configure the "AI" queue's own workflow statuses to
// Open / In Progress / Routed to Dev / Routed to Infra / Routed to QA /
// Routed to Migration / Resolved, matching exactly what clicking
// "+ Add Status" 7 times on that queue's own Workflow tab would produce.
// The "Routed to X" -> auto-move-to-that-queue mechanism already works for
// ANY queue status named that way (confirmed in jira-pg-api.ts's
// queueStatusId handoff handler) -- no code change needed, just this data.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';
const QUEUE_NAME = 'AI';

const STATUSES = [
  { name: 'Open',               category: 'todo',        color: '#6366f1' },
  { name: 'In Progress',        category: 'in_progress', color: '#06b6d4' },
  { name: 'Routed to Dev',      category: 'in_progress', color: '#f59e0b' },
  { name: 'Routed to Infra',    category: 'in_progress', color: '#f59e0b' },
  { name: 'Routed to QA',       category: 'in_progress', color: '#f59e0b' },
  { name: 'Routed to Migration',category: 'in_progress', color: '#f59e0b' },
  { name: 'Resolved',           category: 'done',        color: '#10b981' },
];

async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  if (!rows[0]) { console.error('No custom_queues row for', SPACE_KEY); process.exit(1); }
  const queues = rows[0].queues || [];
  const idx = queues.findIndex((q) => (q.name || '').toLowerCase() === QUEUE_NAME.toLowerCase());
  if (idx === -1) { console.error(`Queue "${QUEUE_NAME}" not found. Existing queues:`, queues.map((q) => q.name)); process.exit(1); }

  const existing = queues[idx].queueStatuses || [];
  if (existing.length > 0) {
    console.log(`"${QUEUE_NAME}" already has ${existing.length} queueStatuses -- leaving them as-is to avoid clobbering anything already configured:`);
    console.log(existing.map((s) => s.name));
    await pool.end();
    return;
  }

  const now = Date.now();
  const newStatuses = STATUSES.map((s, i) => ({
    id: `qst_${now}_${i}`,
    name: s.name,
    color: s.color,
    category: s.category,
    order: i,
  }));

  queues[idx] = { ...queues[idx], queueStatuses: newStatuses };
  await pool.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [JSON.stringify(queues), SPACE_KEY]);
  console.log(`Set ${newStatuses.length} statuses on "${QUEUE_NAME}":`);
  for (const s of newStatuses) console.log(`  ${s.name} (${s.category})`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
