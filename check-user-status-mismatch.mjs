// Read-only: the User Management "Active/Inactive" filter prefers the raw
// `status` column over the `isActive` boolean. If status holds anything
// other than exactly 'active'/'inactive' (e.g. 'invited', stale/null, or a
// mismatch against isActive), those users fall through both filter options
// -- never showing under either "Active" or "Inactive". Find out how many,
// and whether status/isActive actually disagree with each other.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: statusCounts } = await pool.query(`
    SELECT COALESCE(status, '(null)') AS status, COUNT(*) FROM users GROUP BY status ORDER BY COUNT(*) DESC
  `);
  console.log('Distinct raw status values on users table:');
  for (const r of statusCounts) console.log(`  ${r.status}: ${r.count}`);

  const { rows: mismatches } = await pool.query(`
    SELECT id, email, "isActive", status FROM users
    WHERE (status IS NOT NULL AND status NOT IN ('active', 'inactive'))
       OR (status = 'active' AND "isActive" = false)
       OR (status = 'inactive' AND "isActive" = true)
  `);
  console.log(`\nUsers whose status/isActive disagree or fall outside active/inactive: ${mismatches.length}`);
  for (const m of mismatches.slice(0, 30)) console.log(` - ${m.email}: status=${m.status}, isActive=${m.isActive}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
