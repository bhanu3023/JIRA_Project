// Verifies exactly what the backfill wrote for CF-29589 -- the --keys
// restriction is per ticket, not per (ticket, person), so it wrote
// 'worked' credit for EVERY person with a qualifying event on that ticket,
// not just Naveed. bala.raviteja and dathu.kaluvala both got events
// flagged for "Dev" in the dry run, but their own dept_assignees snapshot
// for this ticket is Infra and Migration respectively -- checking whether
// they were really wrongly credited for Dev.
//
// Read-only.
//
// Usage: node check-cf29589-credit-state.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT id, dept_assignees FROM issues WHERE cf_key = 'CF-29589' OR key = 'CF-29589'`);
  const issue = rows[0];
  console.log(`dept_assignees=${JSON.stringify(issue.dept_assignees)}\n`);

  const { rows: worked } = await pool.query(
    `SELECT wu.email, w.dept, w.reason, w.worked_at FROM user_worked_on_tickets w
     JOIN users wu ON wu.id = w.user_id WHERE w.issue_id = $1 ORDER BY w.dept, wu.email`,
    [issue.id]
  );
  console.log('Current user_worked_on_tickets rows for CF-29589:');
  for (const w of worked) console.log(`  ${w.email}  dept=${w.dept}  reason=${w.reason}  worked_at=${w.worked_at.toISOString()}`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
