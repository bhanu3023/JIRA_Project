// CF-29399: the apply wrote a NEW 'worked' Dev credit for bala.raviteja
// (whose real snapshot dept for this ticket is Infra, per dept_assignees)
// -- the same person already confirmed as a false positive on CF-29589 --
// while Jaswanth's own event (found by check-jaswanth-3-missing.mjs at
// 2026-08-13T19:12:13.754Z) was never written at all. Pulls full history
// to see (1) why Jaswanth's real event didn't match, and (2) whether
// bala.raviteja's credit is legitimate or another mis-attributed handoff
// artifact.
//
// Read-only.
//
// Usage: node check-cf29399-full-history.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT id FROM issues WHERE cf_key = 'CF-29399' OR key = 'CF-29399'`);
  const issueId = rows[0].id;

  console.log('=== Full history for CF-29399 ===');
  const { rows: hist } = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt"
     FROM issue_history WHERE "issueId" = $1 ORDER BY "createdAt" ASC`,
    [issueId]
  );
  for (const h of hist) {
    console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}"  (by "${h.authorName}" <${h.authorEmail}>)`);
  }

  console.log('\n=== Current worked-on rows ===');
  const { rows: worked } = await pool.query(
    `SELECT wu.email, w.dept, w.reason, w.worked_at FROM user_worked_on_tickets w
     JOIN users wu ON wu.id = w.user_id WHERE w.issue_id = $1 ORDER BY w.worked_at ASC`,
    [issueId]
  );
  for (const w of worked) console.log(`  ${w.email}  dept=${w.dept}  reason=${w.reason}  at=${w.worked_at.toISOString()}`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
