// Checks whether there's a DB trigger on the issues table that auto-
// bumps updatedAt on ANY row update (even to unrelated columns) -- if
// so, every maintenance/bulk-fix UPDATE ever run against `issues`
// (deploy-time cleanup queries, one-off backfill scripts, this
// session's own fix scripts) would have silently destroyed the real
// last-activity date for every row it touched, explaining the massive
// updatedAt spikes on several unrelated dates. Read-only.
//
// Usage: node check-updatedat-trigger.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: triggers } = await pool.query(`
    SELECT trigger_name, event_manipulation, action_timing, action_statement
    FROM information_schema.triggers
    WHERE event_object_table = 'issues'
  `);
  console.log('Triggers on issues table:', JSON.stringify(triggers, null, 2));

  // Also check if updatedAt has a column default that re-evaluates on
  // every UPDATE (not possible via DEFAULT alone in Postgres, but worth
  // confirming there's no generated-column trickery).
  const { rows: colInfo } = await pool.query(`
    SELECT column_name, column_default, is_generated, generation_expression
    FROM information_schema.columns
    WHERE table_name = 'issues' AND column_name = 'updatedAt'
  `);
  console.log('\nupdatedAt column definition:', JSON.stringify(colInfo, null, 2));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
