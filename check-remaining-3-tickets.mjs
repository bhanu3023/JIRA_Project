// Read-only: investigate the 3 tickets still flagged suspicious by the
// corrected v2 audit.
// CF-26760/CF-26473: resolved, Lowest priority (Dev explicitly 0h/removed),
//   yet still showing breached -- likely a frozen sla_snapshot carrying a
//   wrong verdict from before today's fixes existed.
// CF-19862: reopened (status back to non-done), dept_sla_log.QA still says
//   "paused" from when it was originally resolved, even though the ticket
//   is genuinely active again in QA right now -- does reopening a ticket
//   correctly resume/reset the department's SLA clock at all?
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  for (const key of ['CF-26760', 'CF-26473']) {
    const { rows } = await pool.query(`
      SELECT COALESCE(cf_key,key) AS key, current_department, dept_sla_log, sla_snapshot, sla_waivers,
             "resolvedAt", jira_sla_breached, priority
      FROM issues WHERE cf_key = $1 OR key = $1
    `, [key]);
    const r = rows[0];
    console.log(`\n${key}: current_department=${r.current_department}, priority=${r.priority}, resolvedAt=${r.resolvedAt}, jira_sla_breached=${r.jira_sla_breached}`);
    console.log('dept_sla_log:', JSON.stringify(r.dept_sla_log));
    console.log('sla_snapshot:', JSON.stringify(r.sla_snapshot, null, 2));
    console.log('sla_waivers:', JSON.stringify(r.sla_waivers));
  }

  console.log('\n\n=== CF-19862 reopen handling ===');
  const { rows } = await pool.query(`
    SELECT COALESCE(cf_key,key) AS key, dept_sla_log, dept_sla_started_at, current_department
    FROM issues WHERE cf_key = 'CF-19862' OR key = 'CF-19862'
  `);
  console.log(JSON.stringify(rows[0], null, 2));

  // status-change history around the reopen (Oct19 resolve -> later reopen)
  const { rows: hist } = await pool.query(`
    SELECT h.field, h."oldValue", h."newValue", h."authorName", h."createdAt"
    FROM issue_history h JOIN issues i ON i.id = h."issueId"
    WHERE (i.cf_key = 'CF-19862' OR i.key = 'CF-19862')
      AND h.field IN ('status', 'sla')
    ORDER BY h."createdAt" ASC
  `);
  console.log('\nStatus/SLA history:');
  for (const h of hist) console.log(` - [${h.createdAt.toISOString()}] ${h.field}: ${h.oldValue} -> ${h.newValue}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
