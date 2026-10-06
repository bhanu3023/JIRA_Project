// CF-30865/CF-33222's Migration SLA policy computed durationMs=0 --
// wrong; Due should be Start + the real configured duration for this
// ticket's priority. Checking the ticket's priority and the actual
// SLA policy/settings data for Migration to find why 0 is being used
// instead of the real value. Read-only.
//
// Usage: node check-cf30865-duration-source.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  for (const key of ['CF-30865', 'CF-33222']) {
    const { rows } = await pool.query(`
      SELECT id, key, cf_key, priority, "spaceId", "createdAt"
      FROM issues WHERE cf_key = $1 OR key = $1 LIMIT 1
    `, [key]);
    const issue = rows[0];
    console.log(`\n=== ${key} ===`);
    console.log('priority:', issue.priority, 'createdAt:', issue.createdAt?.toISOString?.());

    // SLA policies that could apply to Migration dept
    const { rows: policies } = await pool.query(`
      SELECT id, name, dept_name, priority, duration, active, "spaceId"
      FROM sla_definitions
      WHERE "spaceId" = $1 AND (LOWER(dept_name) = 'migration' OR dept_name IS NULL)
      ORDER BY active DESC, dept_name, priority
    `, [issue.spaceId]);
    console.log('sla_definitions rows for this space (Migration + space-wide):');
    for (const p of policies) {
      console.log(`  id=${p.id} name="${p.name}" dept=${p.dept_name} priority=${p.priority} duration=${JSON.stringify(p.duration)} active=${p.active}`);
    }
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
