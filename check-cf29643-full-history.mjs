// CF-29643 is Srinu Gudimitla's one confirmed genuine ticket -- but the
// wider dry-run scan also flagged bhanu.srikakulam on this same ticket,
// and CF-29589 already proved a second person on a shared ticket can be a
// false positive from the handoff-timing ambiguity (multiple history
// fields changing within the same millisecond). Pulls the full history to
// check both people's real actions before applying anything.
//
// Read-only.
//
// Usage: node check-cf29643-full-history.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT id FROM issues WHERE cf_key = 'CF-29643' OR key = 'CF-29643'`);
  const issueId = rows[0].id;

  console.log('=== Full history for CF-29643 ===');
  const { rows: hist } = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt"
     FROM issue_history WHERE "issueId" = $1 ORDER BY "createdAt" ASC`,
    [issueId]
  );
  for (const h of hist) {
    console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}"  (by ${h.authorName} <${h.authorEmail}>)`);
  }

  console.log('\n=== All worked-on rows ===');
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
