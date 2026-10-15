// Narrows down WHY MBR's total differs from Filters' "Worked" count for
// Rehan Khan in Dev, for the "This month" range where the gap is smallest
// (61 vs 59) -- easiest to inspect by hand.
//
// Usage: node check-rehan-mismatch-cause.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const FROM = '2026-10-01';
const TO = '2026-10-15';

async function main() {
  const { rows: userRows } = await pool.query(`SELECT id, email FROM users WHERE email = 'rehan.khan@cloudfuze.com'`);
  const rehan = userRows[0];

  // Every user_worked_on_tickets row for Rehan in Dev within this window,
  // broken down by `reason` -- to see if 'passed' rows are the gap.
  const { rows } = await pool.query(`
    SELECT w.reason, COUNT(*) AS cnt
    FROM user_worked_on_tickets w
    JOIN issues i ON i.id = w.issue_id
    WHERE w.user_id = $1 AND LOWER(w.dept) = 'dev'
      AND w.worked_at BETWEEN $2 AND ($3::date + interval '1 day')
    GROUP BY w.reason
  `, [rehan.id, FROM, TO]);
  console.log('user_worked_on_tickets rows for Rehan in Dev, by reason (worked_at in range):');
  for (const r of rows) console.log(` ${r.reason}: ${r.cnt}`);

  // How many DISTINCT issues that is (a person can have multiple rows --
  // one per dept visited -- but we already scope to dept='dev' above).
  const { rows: distinctRows } = await pool.query(`
    SELECT COUNT(DISTINCT w.issue_id) AS cnt
    FROM user_worked_on_tickets w
    WHERE w.user_id = $1 AND LOWER(w.dept) = 'dev'
      AND w.worked_at BETWEEN $2 AND ($3::date + interval '1 day')
  `, [rehan.id, FROM, TO]);
  console.log('\nDistinct issues (any reason):', distinctRows[0].cnt);

  const { rows: noPassedRows } = await pool.query(`
    SELECT COUNT(DISTINCT w.issue_id) AS cnt
    FROM user_worked_on_tickets w
    WHERE w.user_id = $1 AND LOWER(w.dept) = 'dev' AND w.reason != 'passed'
      AND w.worked_at BETWEEN $2 AND ($3::date + interval '1 day')
  `, [rehan.id, FROM, TO]);
  console.log("Distinct issues (excluding reason='passed'):", noPassedRows[0].cnt);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
