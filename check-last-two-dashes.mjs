// After the broadened any-status-change fallback, 17/19 people now show a
// real number -- Ankit Mishra and Mayank Jain (3 tickets each) still show
// a dash. Checking whether that's the one remaining legitimate case
// (tickets genuinely never touched/no status history since arriving in
// this department, or dept_sla_started_at itself missing) or another edge
// case worth fixing.
//
// Read-only.
//
// Usage: node check-last-two-dashes.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const EMAILS = ['ankit@cloudfuze.com', 'mayank@cloudfuze.com'];

async function main() {
  for (const email of EMAILS) {
    console.log(`\n\n========== ${email} ==========`);
    const { rows: userRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    const userId = userRows[0]?.id;
    if (!userId) { console.log('not found'); continue; }

    const { rows: issues } = await pool.query(
      `SELECT id, cf_key, key, current_department, dept_sla_started_at, "statusId" FROM issues WHERE "assigneeId" = $1 ORDER BY "updatedAt" DESC LIMIT 10`,
      [userId]
    );
    for (const issue of issues) {
      console.log(`\n${issue.cf_key || issue.key} (dept=${issue.current_department}) dept_sla_started_at=${issue.dept_sla_started_at ? new Date(issue.dept_sla_started_at).toISOString() : 'NULL'}`);
      const { rows: hist } = await pool.query(
        `SELECT field, "oldValue", "newValue", "authorEmail", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'status' ORDER BY "createdAt" ASC`,
        [issue.id]
      );
      if (!hist.length) { console.log('  (no status history at all)'); continue; }
      for (const h of hist) console.log(`  [${h.createdAt.toISOString()}] ${h.oldValue} -> ${h.newValue} (by ${h.authorEmail})`);
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
