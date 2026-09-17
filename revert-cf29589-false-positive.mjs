// Reverts the 2 confirmed false-positive rows the backfill wrote for
// CF-29589: bala.raviteja and dathu.kaluvala both got a brand-new
// reason='worked' Dev credit that didn't exist before ("no row at all" in
// the dry run) -- their real actions were the tail end of a department
// handoff (Infra->Dev, Migration->Dev respectively), not independent Dev
// work, and each already has correct credit elsewhere (bala.raviteja:
// Infra/closed; dathu.kaluvala: Migration/returned). Deletes exactly these
// 2 rows, restoring the pre-backfill state. Does NOT touch Naveed's own
// Dev/worked row on this ticket, which is correct.
//
// Usage: node revert-cf29589-false-positive.mjs [--apply]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows: issueRows } = await pool.query(`SELECT id FROM issues WHERE cf_key = 'CF-29589' OR key = 'CF-29589'`);
  const issueId = issueRows[0].id;

  const { rows: userRows } = await pool.query(
    `SELECT id, email FROM users WHERE email IN ('bala.raviteja@cloudfuze.com', 'dathu.kaluvala@cloudfuze.com')`
  );

  for (const u of userRows) {
    const { rows: existing } = await pool.query(
      `SELECT reason, worked_at FROM user_worked_on_tickets WHERE user_id = $1 AND issue_id = $2 AND dept = 'Dev'`,
      [u.id, issueId]
    );
    if (!existing.length) { console.log(`${u.email}: no Dev row found (already clean?)`); continue; }
    console.log(`${u.email}: found Dev row reason=${existing[0].reason} worked_at=${existing[0].worked_at.toISOString()} -- ${APPLY ? 'DELETING' : 'would delete (dry run)'}`);
    if (APPLY) {
      await pool.query(`DELETE FROM user_worked_on_tickets WHERE user_id = $1 AND issue_id = $2 AND dept = 'Dev'`, [u.id, issueId]);
    }
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
