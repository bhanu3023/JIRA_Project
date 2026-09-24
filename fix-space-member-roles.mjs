// Root cause confirmed: the People & Access page's role <select> only has
// <option>s for ['admin','manager','dev'/'member' after the code fix,'viewer']
// (SPACE_ROLES in settings/page.tsx). Historical space_members rows never
// matched that set -- 108 rows have role="developer" (IA:94, TESTIN:5, SB:9),
// 1 row has role="dev" (TESTIN) -- both meant to become "member" per this
// session's rename -- and 113 rows already have role="member" (CUSTM:1, QT:1,
// TESTIN:111, correctly created by the queue page's Add Member flow, which
// already hardcodes role:'member'). Because a controlled <select> whose value
// doesn't match any <option> silently renders as the FIRST option ("Admin"),
// every one of the 108/1 mismatched rows was displaying as "Admin" in the UI
// regardless of the real stored value.
//
// This script normalizes the legacy values ("developer" and "dev") to
// "member" so they render correctly as "Member" with the code fix already
// applied. Rows already role="member", "admin", "manager", or "viewer" are
// left untouched.
//
// Dry-run by default; pass --apply to write.
//
// Usage: node fix-space-member-roles.mjs [--apply]
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(
    `SELECT sm.id, sp.key AS space_key, sm.role, u."firstName", u."lastName", u.email
     FROM space_members sm JOIN spaces sp ON sp.id = sm."spaceId" JOIN users u ON u.id = sm."userId"
     WHERE sm.role IN ('developer', 'dev') ORDER BY sp.key, u."firstName"`
  );
  console.log(`Found ${rows.length} space_members rows with legacy role values:`);
  for (const r of rows) console.log(`  [${r.space_key}] role="${r.role}" -> "member"  ${r.firstName} ${r.lastName} <${r.email}>`);

  if (!APPLY) {
    console.log(`\nDry run only. Re-run with --apply to update these ${rows.length} rows to role="member".`);
    await pool.end();
    return;
  }

  const { rowCount } = await pool.query(`UPDATE space_members SET role = 'member' WHERE role IN ('developer', 'dev')`);
  console.log(`\nUpdated ${rowCount} rows to role="member".`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
