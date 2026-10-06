// The real SLA table (sla_definitions) has nothing for Infra/QA, confirmed.
// But the queue SETTINGS page falls back to custom_queues.queues[].slaPolicies
// (a denormalized copy) whenever sla_definitions has no rows for that dept --
// if THAT still has stale/leftover policy data, the settings UI could show
// an "enabled" (defaults true when unset) SLA policy even though nothing
// real is configured. Checking that denormalized field directly. Read-only.
//
// Usage: node check-queue-settings-sla-display.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT space_key, queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = rows[0]?.queues || [];
  for (const dept of ['Infra', 'QA']) {
    const q = queues.find(qq => (qq.name || '').toLowerCase() === dept.toLowerCase());
    console.log(`\n${dept} queue's own slaPolicies field (denormalized, settings page fallback):`);
    console.log(JSON.stringify(q?.slaPolicies, null, 2));
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
