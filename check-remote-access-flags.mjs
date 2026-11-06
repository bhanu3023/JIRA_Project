// Read-only diagnostic: list every user and whether can_access_anywhere is
// set, so we can see who (if anyone besides the 9 admins already granted)
// currently has the office/VPN-only restriction bypassed.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT id, "firstName", "lastName", email, role, "isActive", can_access_anywhere
     FROM users ORDER BY can_access_anywhere DESC, "firstName" ASC`,
  );
  console.log(`Total users: ${rows.length}\n`);
  console.log('can_access_anywhere = true:');
  const withAccess = rows.filter(u => u.can_access_anywhere);
  if (!withAccess.length) console.log('  (none)');
  for (const u of withAccess) console.log(`  ${u.firstName} ${u.lastName} <${u.email}> role=${u.role} active=${u.isActive}`);

  console.log(`\ncan_access_anywhere = false/null: ${rows.length - withAccess.length} user(s)`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
