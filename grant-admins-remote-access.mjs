// One-time data change: the new office/VPN-only enforcement (jira-pg-api.ts,
// isOfficeIp) blocks every authenticated request for anyone off-network
// unless users.can_access_anywhere is true -- including Settings > User
// Management itself, which is the only UI that can grant that flag. An
// admin who gets caught by this off-network has no way to self-service a
// fix: they're locked out of the one screen that would unblock them.
//
// Grants can_access_anywhere = true to every current admin-role user, so no
// admin can ever be locked out of their own system this way again. Dry-run
// by default -- pass --apply to write.
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS can_access_anywhere BOOLEAN DEFAULT FALSE`);

  const { rows } = await pool.query(
    `SELECT id, "firstName", "lastName", email, role, can_access_anywhere FROM users WHERE role = 'admin' ORDER BY "firstName"`,
  );
  if (!rows.length) {
    console.log('No admin-role users found. Aborting -- nothing changed.');
    await pool.end();
    return;
  }
  console.log(`Admins found: ${rows.length}`);
  for (const u of rows) console.log(`  ${u.id}  ${u.firstName} ${u.lastName}  <${u.email}>  can_access_anywhere=${u.can_access_anywhere}`);

  const toUpdate = rows.filter((u) => !u.can_access_anywhere);
  if (!toUpdate.length) {
    console.log('\nEvery admin already has can_access_anywhere = true -- nothing to do.');
    await pool.end();
    return;
  }

  if (!APPLY) {
    console.log(`\nDry run only -- would set can_access_anywhere = true for ${toUpdate.length} admin(s). Rerun with --apply to write.`);
    await pool.end();
    return;
  }

  await pool.query(`UPDATE users SET can_access_anywhere = true WHERE role = 'admin'`);
  console.log(`\nGranted can_access_anywhere = true to ${toUpdate.length} admin(s).`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
