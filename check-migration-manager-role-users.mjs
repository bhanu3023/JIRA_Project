// User wants the Project Manager field/filter to dynamically pull from
// whoever currently has the 'migration_manager' role in User Management,
// instead of the hardcoded name list. Check who's actually assigned that
// role right now, to compare against the current hardcoded PM list
// (Harika, Abhishek, Ajay Singh, Abhishikth, Raghu, Lakshmi Prasanna, Sri
// Ram, Chandra Mouli, Sravan, Pranavi, Meghana, Neelima, Others).
//
// Read-only.
//
// Usage: node check-migration-manager-role-users.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT id, email, "firstName", "lastName", "displayName", "isActive" FROM users WHERE role = 'migration_manager' ORDER BY "firstName"`
  );
  console.log(`Users with role = 'migration_manager': ${rows.length}`);
  for (const r of rows) console.log(`  ${r.firstName} ${r.lastName} (${r.email}) active=${r.isActive} displayName=${r.displayName}`);

  console.log('\n=== Distinct roles currently in use, with counts ===');
  const { rows: roleCounts } = await pool.query(
    `SELECT role, COUNT(*) FROM users GROUP BY role ORDER BY COUNT(*) DESC`
  );
  for (const r of roleCounts) console.log(`  ${r.role}: ${r.count}`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
