// User asks whether a space-level "Admin" (e.g. Vamshi Gande shown as Admin
// in IT ADMINISTRATION's People and access) automatically gets every
// notification for that space. The notification code's getAdminRecipients()
// checks users.role = 'admin' (the GLOBAL site-wide role), NOT
// space_members.role (the per-space role shown in that screenshot) -- these
// are two different things. Confirming Vamshi's actual GLOBAL role to give
// a factual yes/no answer instead of guessing.
//
// Read-only.
//
// Usage: node check-vamshi-global-role.mjs
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT u.email, u.role AS global_role, sm.role AS space_role, sp.key AS space_key
     FROM users u
     LEFT JOIN space_members sm ON sm."userId" = u.id
     LEFT JOIN spaces sp ON sp.id = sm."spaceId"
     WHERE u.email IN ('vamshi.gande@cloudfuze.com', 'pavan@cloudfuze.com')
     ORDER BY u.email, sp.key`
  );
  for (const r of rows) console.log(r);

  // Also: how many space_members rows have role='admin' across all spaces,
  // vs how many users.role='admin' globally -- to show the scale of the gap.
  const { rows: spaceAdmins } = await pool.query(
    `SELECT sp.key, COUNT(*) FROM space_members sm JOIN spaces sp ON sp.id = sm."spaceId" WHERE sm.role = 'admin' GROUP BY sp.key`
  );
  console.log('\nSpace-level admins per space:', spaceAdmins);
  const { rows: globalAdmins } = await pool.query(`SELECT email FROM users WHERE role = 'admin' AND "isActive" = true`);
  console.log(`\nGlobal (site-wide) admins (${globalAdmins.length}):`, globalAdmins.map(r => r.email));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
