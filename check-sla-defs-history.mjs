// Need the exact current sla_definitions structure/goals for Migration and Dev
// (is it tiered by priority, or one flat target per dept?) and their exact
// updatedAt timestamps, to build an accurate pre-edit historical override.
// Read-only.
//
// Usage: node check-sla-defs-history.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT id, "spaceId", dept_name, status, goals, "createdAt", "updatedAt"
     FROM sla_definitions
     WHERE dept_name IN ('Migration', 'Dev') OR dept_name ILIKE '%migration%' OR dept_name ILIKE '%dev%'
     ORDER BY dept_name, "createdAt"`
  );
  for (const r of rows) {
    console.log(`\n--- ${r.dept_name} (id=${r.id}, status=${r.status}) ---`);
    console.log(`createdAt: ${r.createdAt}`);
    console.log(`updatedAt: ${r.updatedAt}`);
    console.log(`goals: ${JSON.stringify(r.goals, null, 2)}`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
