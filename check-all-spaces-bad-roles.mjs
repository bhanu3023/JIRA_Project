// SAT_Board has 9/11 members with role="developer" stored in space_members
// (not "dev", which is the only value the People-page <select> actually has
// an <option> for -- SPACE_ROLES = ['admin','manager','dev','viewer']).
// When a controlled <select>'s value doesn't match any <option>, the browser
// silently shows the FIRST option ("Admin"), which is why all these members
// display as Admin regardless of their real stored role. Checking whether
// this same bad-value problem exists in OTHER spaces too, so the fix (and
// backfill) can cover everywhere, not just SAT_Board.
//
// Read-only.
//
// Usage: node check-all-spaces-bad-roles.mjs
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const VALID = new Set(['admin', 'manager', 'dev', 'viewer']);

async function main() {
  const { rows } = await pool.query(
    `SELECT sp.key, sp.name, sm.role, COUNT(*) AS cnt
     FROM space_members sm JOIN spaces sp ON sp.id = sm."spaceId"
     GROUP BY sp.key, sp.name, sm.role ORDER BY sp.key, sm.role`
  );
  let totalBad = 0;
  const bySpace = {};
  for (const r of rows) {
    (bySpace[r.key] ||= []).push(r);
    if (!VALID.has(r.role)) totalBad += Number(r.cnt);
  }
  for (const key of Object.keys(bySpace)) {
    console.log(`\n=== ${key} ===`);
    for (const r of bySpace[key]) {
      const flag = VALID.has(r.role) ? '' : '  <-- INVALID (not in SPACE_ROLES, will misrender as Admin)';
      console.log(`  role="${r.role}"  x${r.cnt}${flag}`);
    }
  }
  console.log(`\nTotal space_members rows with an invalid role: ${totalBad}`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
