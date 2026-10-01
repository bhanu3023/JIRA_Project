// The screenshot Bhanu shared for CF-29908 cuts off at 4:23 AM (Lakshmi's
// comment) -- pulls the COMPLETE status/assignee/department history plus
// every worked-on row, to see what actually happened afterward and verify
// whether check-naveed-16-verdict.mjs's "NO" call for this ticket was
// correct, or missed something (e.g. Naveed retaking it later).
//
// Read-only.
//
// Usage: node check-cf29908-full-history.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'CF-29908';

async function main() {
  const { rows } = await pool.query(`SELECT id FROM issues WHERE cf_key = $1 OR key = $1`, [KEY]);
  const issueId = rows[0].id;

  console.log(`=== Full history for ${KEY} ===`);
  const { rows: hist } = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt"
     FROM issue_history WHERE "issueId" = $1 ORDER BY "createdAt" ASC`,
    [issueId]
  );
  for (const h of hist) {
    console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}"  (by ${h.authorName} <${h.authorEmail}>)`);
  }

  console.log(`\n=== All worked-on rows for ${KEY} ===`);
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
