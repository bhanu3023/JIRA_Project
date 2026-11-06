// One-time data change, per explicit request: give Sruthi the same
// "Awaiting my approval" KB Articles access as a migration_manager/admin,
// via the new per-user can_approve_kb override (see kb-api.ts) -- without
// changing her actual role, which would also affect Filters' assignee
// picker, my-dashboard, and the Home dashboard's Migration Manager section.
//
// Dry-run by default -- pass --apply to write. Aborts without writing if
// the name lookup finds zero or more than one matching user.
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const NAME_LIKE = 'sruthi';

async function main() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS can_approve_kb BOOLEAN DEFAULT FALSE`);

  const { rows } = await pool.query(
    `SELECT id, "firstName", "lastName", email, role, can_approve_kb FROM users WHERE "firstName" ILIKE $1 OR email ILIKE $1`,
    [`%${NAME_LIKE}%`],
  );
  if (rows.length !== 1) {
    console.log(`Expected exactly 1 user matching "${NAME_LIKE}", found ${rows.length}:`);
    for (const u of rows) console.log(`  ${u.id}  ${u.firstName} ${u.lastName}  <${u.email}>  role=${u.role}  can_approve_kb=${u.can_approve_kb}`);
    console.log('\nAborting -- nothing changed.');
    await pool.end();
    return;
  }
  const u = rows[0];
  console.log(`Found: ${u.firstName} ${u.lastName} <${u.email}> (id=${u.id}, role=${u.role})`);
  console.log(`Current can_approve_kb: ${u.can_approve_kb}`);

  if (u.can_approve_kb) {
    console.log('Already has KB approval access -- nothing to do.');
    await pool.end();
    return;
  }

  if (!APPLY) {
    console.log('\nDry run only -- would set can_approve_kb = true. Rerun with --apply to write.');
    await pool.end();
    return;
  }

  await pool.query(`UPDATE users SET can_approve_kb = true WHERE id = $1`, [u.id]);
  console.log(`\nGranted can_approve_kb = true to ${u.firstName} ${u.lastName}.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
