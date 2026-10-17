// Checks whether Rehan Khan's remaining ~28-ticket MBR-vs-Filters gap for
// Sep 2026 comes from reason='passed' rows -- MBR's queries don't filter
// on reason at all, but Filters' workedDeptMatchSql explicitly excludes
// 'passed' (w.reason != 'passed').
//
// Usage: node check-rehan-sep-passed-rows.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const FROM = '2026-09-01';
const TO = '2026-09-30';

async function main() {
  const { rows: u } = await pool.query(`SELECT id FROM users WHERE email = 'rehan.khan@cloudfuze.com'`);
  const rehan = u[0];

  const { rows } = await pool.query(`
    SELECT w.reason, COUNT(DISTINCT w.issue_id) AS distinct_issues
    FROM user_worked_on_tickets w
    WHERE w.user_id = $1 AND LOWER(w.dept) = 'dev'
      AND w.worked_at BETWEEN ($2::date) AND ($3::date + interval '1 day' - interval '1 second')
    GROUP BY w.reason
  `, [rehan.id, FROM, TO]);
  console.log("Rehan's user_worked_on_tickets rows in Dev for Sep 2026, by reason:");
  for (const r of rows) console.log(`  ${r.reason}: ${r.distinct_issues}`);

  const { rows: current } = await pool.query(`
    SELECT COUNT(*) AS cnt FROM issues i
    WHERE i."assigneeId" = $1 AND LOWER(i.current_department) = 'dev'
      AND ((i."createdAt" BETWEEN $2::date AND $3::date + interval '1 day') OR (i."updatedAt" BETWEEN $2::date AND $3::date + interval '1 day'))
  `, [rehan.id, FROM, TO]);
  console.log('\nTickets where Rehan is CURRENT assignee in Dev, created/updated in Sep 2026:', current[0].cnt);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
