// CF-30865/CF-33222's priority is "highest", and the historical
// override only covers Migration+medium (confirmed null for
// "highest"), so durationMs=0 must be coming from the LIVE policy's
// own goals JSON. Checking policy pg_x56k9og8ye's exact goals
// structure to find the real bug. Read-only.
//
// Usage: node check-migration-policy-goals.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT id, name, "dept_name", goals, status
    FROM sla_definitions WHERE id = 'pg_x56k9og8ye'
  `);
  console.log(JSON.stringify(rows, null, 2));
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
