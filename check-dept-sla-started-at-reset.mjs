// Read-only: CF-34499's frozen Migration snapshot has startedAt=Oct26
// 10:02:27 AM (its very first, 1-minute Migration visit, immediately
// paused) -- but its FINAL, resolution-ending Migration visit was Oct27
// 18:53:10 PM. If dept_sla_started_at isn't correctly resetting on a
// RE-ENTRY to a previously-visited department (as opposed to a department
// never visited before), every multi-bounce ticket's Start/Due/"Actively
// worked" display could be anchored to the wrong, stale, much-earlier visit.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, i.dept_sla_started_at, i.dept_sla_log, i.current_department
    FROM issues i WHERE i.cf_key = 'CF-34499' OR i.key = 'CF-34499'
  `);
  const r = rows[0];
  console.log('current_department:', r.current_department);
  console.log('dept_sla_started_at (top-level column, last-set value):', r.dept_sla_started_at);
  console.log('\ndept_sla_log.Migration:', JSON.stringify(r.dept_sla_log?.Migration, null, 2));

  // Every "SLA started"/"SLA resumed" event naming Migration specifically,
  // to see the full sequence of (re-)entries.
  const { rows: slaHist } = await pool.query(`
    SELECT "newValue", "createdAt" FROM issue_history
    WHERE "issueId" = $1 AND field = 'sla' AND "newValue" ILIKE '%Migration%'
    ORDER BY "createdAt" ASC
  `, [r.id]);
  console.log('\nEvery Migration-related SLA event:');
  for (const h of slaHist) console.log(` - [${h.createdAt.toISOString()}] ${h.newValue}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
