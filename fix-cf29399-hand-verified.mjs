// Hand-verified fix for CF-29399, built from reading its full history
// directly (not the general heuristic backfill script, which got this one
// wrong in two different ways):
//
// 1. bala.raviteja's Dev/worked row (written by the last backfill --apply)
//    is a false positive -- his "Resolved -> Waiting for Dev" status
//    change at 19:19:34.839 was the automatic side-effect of HIS OWN
//    department transfer (Infra -> Dev), not real work he did in Dev. His
//    real work was in Infra, where he already correctly has a 'closed'
//    credit. Revert this row (delete it -- it didn't exist before).
//
// 2. jaswanth.adari's real Dev work on this ticket is proven by his own
//    root cause ("The email id is different in cloud and postman",
//    19:26:36) and fix description ("Updated the emailid in cloud
//    collection and verified in postam", 19:27:15) -- freeform technical
//    content only the person actually doing the work would write, dated
//    AFTER the ticket came back to Dev. His existing credit row was
//    downgraded to reason='passed' at 19:30:30 when the ticket was handed
//    to Migration moments later -- the same already-fixed-going-forward
//    bug, just not caught by the automated script because the assignee-
//    history log has a gap (no logged "reassigned back to him" event,
//    even though he's clearly the one working it). Restore to 'worked'
//    with worked_at at his fix-description timestamp -- the last concrete
//    evidence of his real work before the handoff.
//
// Usage: node fix-cf29399-hand-verified.mjs [--apply]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows: issueRows } = await pool.query(`SELECT id FROM issues WHERE cf_key = 'CF-29399' OR key = 'CF-29399'`);
  const issueId = issueRows[0].id;

  const { rows: users } = await pool.query(
    `SELECT id, email FROM users WHERE email IN ('bala.raviteja@cloudfuze.com', 'jaswanth.adari@cloudfuze.com')`
  );
  const bala = users.find((u) => u.email === 'bala.raviteja@cloudfuze.com');
  const jaswanth = users.find((u) => u.email === 'jaswanth.adari@cloudfuze.com');

  const { rows: balaRow } = await pool.query(
    `SELECT reason, worked_at FROM user_worked_on_tickets WHERE user_id = $1 AND issue_id = $2 AND dept = 'Dev'`,
    [bala.id, issueId]
  );
  if (balaRow.length) {
    console.log(`bala.raviteja: found Dev row reason=${balaRow[0].reason} worked_at=${balaRow[0].worked_at.toISOString()} -- ${APPLY ? 'DELETING' : 'would delete (dry run)'}`);
    if (APPLY) await pool.query(`DELETE FROM user_worked_on_tickets WHERE user_id = $1 AND issue_id = $2 AND dept = 'Dev'`, [bala.id, issueId]);
  } else {
    console.log('bala.raviteja: no Dev row found (already clean?)');
  }

  const { rows: jRow } = await pool.query(
    `SELECT reason, worked_at FROM user_worked_on_tickets WHERE user_id = $1 AND issue_id = $2 AND dept = 'Dev'`,
    [jaswanth.id, issueId]
  );
  console.log(`jaswanth.adari: current Dev row = ${jRow.length ? `reason=${jRow[0].reason} worked_at=${jRow[0].worked_at.toISOString()}` : 'none'}`);
  const fixDescriptionAt = new Date('2026-08-13T19:27:15.222Z');
  console.log(`  -- ${APPLY ? 'SETTING' : 'would set (dry run)'} to reason='worked' worked_at=${fixDescriptionAt.toISOString()}`);
  if (APPLY) {
    await pool.query(
      `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason, worked_at)
       VALUES ($1, $2, 'Dev', 'worked', $3)
       ON CONFLICT (user_id, issue_id, dept) DO UPDATE SET reason = 'worked', worked_at = $3`,
      [jaswanth.id, issueId, fixDescriptionAt]
    );
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
