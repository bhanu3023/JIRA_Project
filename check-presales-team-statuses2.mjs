// Follow-up: Pre-Sales-Team's queueStatuses is empty, so it must be using
// TESTIN's own space-wide `statuses` table directly. Confirm those rows
// exist with the exact names shown in the UI, and that "Routed to X"
// parses to a real queue name.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [SPACE_KEY]);
  const spaceId = spaceRows[0]?.id;
  if (!spaceId) { console.log('Space not found'); await pool.end(); return; }

  const { rows: statuses } = await pool.query(
    `SELECT id, name, category, "order" FROM statuses WHERE "spaceId" = $1 ORDER BY "order"`,
    [spaceId]
  );
  console.log(`${SPACE_KEY}'s own statuses table (${statuses.length} rows):`);
  for (const s of statuses) {
    console.log(`  id=${s.id} name="${s.name}" category=${s.category} order=${s.order}`);
    const m = String(s.name || '').match(/^(?:waiting\s+for|routed\s+to)\s+(.+)$/i);
    if (m) console.log(`    -> parses to targetDept="${m[1].trim()}"`);
  }

  const { rows: qrows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = qrows[0]?.queues || [];
  console.log('\nReal queue names to match against:', queues.map((q) => q.name));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
