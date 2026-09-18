// Verifying the CF-29758 apply result (jaswanth.adari, Dev, real status
// change at 2026-08-25T18:20:09.482Z) wasn't the same class of false
// positive found twice now on CF-29589 and CF-29399 -- a status change
// that's really just the automatic side-effect of a department transfer,
// not independent work. Pulls full history to confirm.
//
// Read-only.
//
// Usage: node check-cf29758-full-history.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT id FROM issues WHERE cf_key = 'CF-29758' OR key = 'CF-29758'`);
  const issueId = rows[0].id;

  console.log('=== Full history for CF-29758 ===');
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
