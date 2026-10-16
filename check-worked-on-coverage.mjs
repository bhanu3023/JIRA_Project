// Read-only check: how far back does user_worked_on_tickets actually have
// data, and how many RESOLVED Dev tickets exist that have NO row in that
// table at all (meaning Filters' workedRange-based queries can never find
// them, regardless of any flag) -- to size up what a historical backfill
// would need to cover.
//
// Usage: node check-worked-on-coverage.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: bounds } = await pool.query(`SELECT MIN(worked_at) AS earliest, MAX(worked_at) AS latest, COUNT(*) AS total_rows FROM user_worked_on_tickets`);
  console.log('user_worked_on_tickets coverage:', bounds[0]);

  // Dev-department tickets (current or ever-Dev via dept_sla_log), grouped by
  // month of createdAt, with how many have ZERO user_worked_on_tickets rows
  // for ANY user/dept at all (not just Rehan) -- a ticket with zero rows here
  // can never be found by any workedRange-based Filters query no matter what.
  const { rows: byMonth } = await pool.query(`
    SELECT to_char(i."createdAt", 'YYYY-MM') AS month,
           COUNT(*) AS total_dev_tickets,
           COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM user_worked_on_tickets w WHERE w.issue_id = i.id)) AS missing_any_worked_row
    FROM issues i
    WHERE i."spaceId" = (SELECT id FROM spaces WHERE key = 'TESTIN')
      AND (LOWER(i.current_department) = 'dev' OR i.dept_sla_log ? 'Dev' OR i.dept_sla_log ? 'dev')
    GROUP BY 1 ORDER BY 1 ASC
  `);
  console.log('\nDev-related tickets per month, and how many have ZERO user_worked_on_tickets rows at all:');
  for (const r of byMonth) console.log(`  ${r.month}: ${r.total_dev_tickets} tickets, ${r.missing_any_worked_row} missing any worked-on row`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
