// Read-only check: exactly which user_worked_on_tickets rows collide for
// the Pre-Sales-Old -> Pre-Sales rename, and with what EXACT (case-
// sensitive) dept string values -- my first fix only handled one old-vs-
// new conflict per (user, issue) pair; if there are multiple DIFFERENTLY-
// CASED rows all matching "pre-sales-old" case-insensitively for the SAME
// (user, issue), the DB's unique constraint (which IS case-sensitive)
// would already have allowed them to coexist, and renaming all of them to
// the identical target string collides with EACH OTHER, not just a
// pre-existing "Pre-Sales" row.
//
// Usage: node check-presales-worked-on-dupes.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const OLD_NAME = 'Pre-Sales';
const NEW_NAME = 'Pre-Sales-Old';
const SPACE_KEY = 'TESTIN';

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [SPACE_KEY]);
  const spaceId = spaceRows[0]?.id;

  const { rows } = await pool.query(`
    SELECT w.user_id, w.issue_id, w.dept, w.reason, w.worked_at
    FROM user_worked_on_tickets w
    WHERE LOWER(w.dept) = LOWER($1) AND w.issue_id IN (SELECT id FROM issues WHERE "spaceId" = $2)
    ORDER BY w.user_id, w.issue_id
  `, [OLD_NAME, spaceId]);
  console.log(`${rows.length} rows match "${OLD_NAME}" case-insensitively.\n`);

  const exactDeptValues = new Set(rows.map((r) => r.dept));
  console.log('Distinct EXACT dept string values found:', Array.from(exactDeptValues));

  // Group by (user_id, issue_id) to find any pair with MORE THAN ONE row
  // among just the old-name matches themselves (different casing variants
  // coexisting under the DB's case-sensitive unique constraint).
  const byPair = new Map();
  for (const r of rows) {
    const key = `${r.user_id}:${r.issue_id}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(r);
  }
  const multiOldRows = Array.from(byPair.values()).filter((g) => g.length > 1);
  console.log(`\n(user,issue) pairs with MULTIPLE old-name-matching rows (different casing): ${multiOldRows.length}`);
  for (const g of multiOldRows.slice(0, 10)) console.log(' ', g);

  // Also check: for each old-name row, does a NEW_NAME row already exist
  // for the SAME (user, issue)?
  const { rows: newRows } = await pool.query(`
    SELECT user_id, issue_id, dept, reason, worked_at
    FROM user_worked_on_tickets
    WHERE LOWER(dept) = LOWER($1) AND issue_id IN (SELECT id FROM issues WHERE "spaceId" = $2)
  `, [NEW_NAME, spaceId]);
  console.log(`\n${newRows.length} rows already match "${NEW_NAME}" case-insensitively (before any rename).`);
  const newPairs = new Set(newRows.map((r) => `${r.user_id}:${r.issue_id}`));
  const oldVsNewConflicts = Array.from(byPair.keys()).filter((k) => newPairs.has(k));
  console.log(`(user,issue) pairs with BOTH a "${OLD_NAME}" row and a "${NEW_NAME}" row: ${oldVsNewConflicts.length}`);
  if (oldVsNewConflicts.length) {
    console.log('Example conflicting pairs:');
    for (const k of oldVsNewConflicts.slice(0, 10)) {
      console.log('  old:', byPair.get(k));
      console.log('  new:', newRows.filter((r) => `${r.user_id}:${r.issue_id}` === k));
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
