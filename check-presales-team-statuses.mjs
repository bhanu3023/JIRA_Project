// Read-only check: Pre-Sales-Team's own queueStatuses config (the status
// pills shown when viewing/editing a ticket inside that queue) and the
// real department/queue names that exist in the same space, so we can
// confirm "Routed to Dev"/"Routed to Migration"/etc. will actually match
// a real queue performDeptHandoff can route to.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';

async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = rows[0]?.queues || [];
  console.log(`All queue names in ${SPACE_KEY}:`, queues.map((q) => q.name));

  const presales = queues.find((q) => (q.name || '').toLowerCase() === 'pre-sales-team');
  if (!presales) { console.log('Pre-Sales-Team queue not found'); await pool.end(); return; }

  console.log('\nPre-Sales-Team queueStatuses:');
  for (const s of presales.queueStatuses || []) {
    console.log(`  id=${s.id} name="${s.name}" category=${s.category}`);
    const m = String(s.name || '').match(/^(?:waiting\s+for|routed\s+to)\s+(.+)$/i);
    if (m) {
      const target = m[1].trim();
      const matches = queues.find((q) => (q.name || '').toLowerCase() === target.toLowerCase());
      console.log(`    -> parses to targetDept="${target}" -- matches a real queue: ${!!matches}${matches ? ` (real name: "${matches.name}")` : ' -- NO MATCH, handoff would silently fail to find a destination'}`);
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
