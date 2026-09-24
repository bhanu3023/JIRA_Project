// User reports ALL 11 SAT_Board members show role "Admin" in the People and
// access table, but the role <select> uses value={m.role} against SPACE_ROLES
// ['admin','manager','dev','viewer'] with no <option> for other DB values
// (space_members.role defaults to 'agent' per schema.prisma, and the Add
// Member modal's openModal() sets selectedRole to 'developer', neither of
// which appear in SPACE_ROLES) -- when a <select>'s value doesn't match any
// <option>, browsers silently render the FIRST option, which is "Admin".
// This checks the REAL stored role values to confirm that theory instead of
// guessing.
//
// Read-only.
//
// Usage: node check-satboard-member-roles.mjs
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: spaces } = await pool.query(`SELECT id, key, name FROM spaces WHERE key ILIKE '%SAT%' OR name ILIKE '%SAT%'`);
  console.log('Matching spaces:', spaces);
  for (const sp of spaces) {
    const { rows } = await pool.query(
      `SELECT sm.role, u."firstName", u."lastName", u.email, u.role AS global_role
       FROM space_members sm JOIN users u ON u.id = sm."userId"
       WHERE sm."spaceId" = $1 ORDER BY u."firstName"`,
      [sp.id]
    );
    console.log(`\n=== ${sp.key} (${sp.name}) — ${rows.length} members ===`);
    for (const r of rows) console.log(`  role="${r.role}"  global_role="${r.global_role}"  ${r.firstName} ${r.lastName} <${r.email}>`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
