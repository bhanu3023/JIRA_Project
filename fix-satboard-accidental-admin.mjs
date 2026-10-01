// The row-level role <select> on the People & Access page computes its
// displayed value as `m.role || 'agent'` with no fallback for a value that
// isn't one of SPACE_ROLES (admin/manager/member/viewer). Right after the
// fix-space-member-roles.mjs backfill ran, a still-open/stale browser tab
// (holding the OLD role="developer" for some SB members, fetched before the
// backfill) caused the <select> to silently render/select "Admin" (the
// browser's default when a controlled <select>'s value matches no option),
// and interacting with that dropdown then wrote role="admin" back to the DB
// for real -- confirmed for Abhinav Surattu, Anush Dasari, and Manmadha
// Jayamangala in SB, none of whom were ever intended to be admins (their
// original bad value was "developer", meant to become "member").
//
// This resets any of the 109 originally-legacy-role users (dry run below,
// matching fix-space-member-roles.mjs's original list) who currently show
// role="admin" in a space where they were never a real admin, back to
// "member" -- skipping Bhanu Srikakulam and any space's actual creator/real
// admins are simply not in this list to begin with, so this can't touch a
// legitimate admin.
//
// Dry-run by default; pass --apply to write.
//
// Usage: node fix-satboard-accidental-admin.mjs [--apply]
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

// The exact (space key, email) pairs originally backfilled from
// "developer"/"dev" -> "member" by fix-space-member-roles.mjs.
const ORIGINALLY_BAD = [
  ['SB','abhilasha.kandakatla@cloudfuze.com'],['SB','abhinav.surattu@cloudfuze.com'],
  ['SB','anush.dasari@cloudfuze.com'],['SB','lavanya.gopasana@cloudfuze.com'],
  ['SB','manmadha.jayamangala@cloudfuze.com'],['SB','nagalakshmi.mangina@cloudfuze.com'],
  ['SB','roopa.yerrabothu@cloudfuze.com'],['SB','srinidh.perla@cloudfuze.com'],
  ['SB','sruthi.chimata@cloudfuze.com'],
];

async function main() {
  const { rows } = await pool.query(
    `SELECT sm.id, sm.role, sp.key AS space_key, u.email, u."firstName", u."lastName"
     FROM space_members sm JOIN spaces sp ON sp.id = sm."spaceId" JOIN users u ON u.id = sm."userId"
     WHERE sp.key = 'SB'`
  );
  const byKey = new Map(rows.map(r => [`${r.space_key}|${r.email.toLowerCase()}`, r]));

  const toFix = [];
  for (const [spaceKey, email] of ORIGINALLY_BAD) {
    const r = byKey.get(`${spaceKey}|${email.toLowerCase()}`);
    if (r && r.role === 'admin') toFix.push(r);
  }

  console.log(`Found ${toFix.length} originally-legacy-role SB members now incorrectly showing role="admin":`);
  for (const r of toFix) console.log(`  [${r.space_key}] "${r.role}" -> "member"  ${r.firstName} ${r.lastName} <${r.email}>  (id=${r.id})`);

  if (!APPLY) {
    console.log(`\nDry run only. Re-run with --apply to reset these ${toFix.length} rows to role="member".`);
    await pool.end();
    return;
  }
  for (const r of toFix) {
    await pool.query(`UPDATE space_members SET role = 'member' WHERE id = $1`, [r.id]);
  }
  console.log(`\nReset ${toFix.length} rows to role="member".`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
