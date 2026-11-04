// Grants Jyoshitha the cross-ticket "Worklog" tab (GET /worklogs) without
// making her a full admin, via the new can_view_worklog column. Matches by
// email (case-insensitive), dry-run by default -- pass --apply to write.
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const EMAIL = 'Jyoshitha.Dhannapaneni@cloudfuze.com';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT id, "firstName", "lastName", email, role, can_view_worklog FROM users WHERE LOWER(email) = LOWER($1)`,
    [EMAIL],
  );
  if (!rows.length) {
    console.error(`No user found with email ${EMAIL}`);
    await pool.end();
    process.exit(1);
  }
  const u = rows[0];
  console.log('Found user:', { id: u.id, name: `${u.firstName} ${u.lastName}`, email: u.email, role: u.role, can_view_worklog: u.can_view_worklog });

  if (u.can_view_worklog) {
    console.log('Already has can_view_worklog = true -- nothing to do.');
    await pool.end();
    return;
  }

  if (!APPLY) {
    console.log('\nDry run only -- rerun with --apply to actually grant access.');
    await pool.end();
    return;
  }

  await pool.query(`UPDATE users SET can_view_worklog = TRUE WHERE id = $1`, [u.id]);
  console.log(`Granted can_view_worklog = true to ${u.email}.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
