// Read-only check of CF-34076's department history and per-department SLA
// log, to see whether it only ever sat in Migration (single SLA card is
// correct) or passed through other departments too (which should each get
// their own SLA card/breakdown against their own queue's SLA goal).
//
// Usage: node check-cf34076-sla.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'CF-34076';

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, i.key, i.cf_key, i.current_department, i.dept_sla_log, i.dept_statuses,
           i.sla_snapshot, i."createdAt", i."resolvedAt"
    FROM issues i WHERE i.key = $1 OR i.cf_key = $1 LIMIT 1
  `, [KEY]);
  const issue = rows[0];
  if (!issue) { console.log(`${KEY} not found`); await pool.end(); return; }

  console.log(`=== ${KEY} ===`);
  console.log('Current department:', issue.current_department);
  console.log('Created:', issue.createdAt, '  Resolved:', issue.resolvedAt);
  console.log('\n--- dept_sla_log (per-department elapsed time) ---');
  console.log(JSON.stringify(issue.dept_sla_log, null, 2));
  console.log('\n--- dept_statuses ---');
  console.log(JSON.stringify(issue.dept_statuses, null, 2));
  console.log('\n--- sla_snapshot (frozen, what the UI reads for resolved tickets) ---');
  console.log(JSON.stringify(issue.sla_snapshot, null, 2));

  const { rows: hist } = await pool.query(`
    SELECT field, "oldValue", "newValue", "createdAt", author_name
    FROM issue_history WHERE "issueId" = $1 AND field IN ('department','sla','status')
    ORDER BY "createdAt" ASC
  `, [issue.id]);
  console.log('\n--- department/sla/status history ---');
  for (const h of hist) console.log(`${h.createdAt.toISOString()}  [${h.field}]  ${h.author_name}: ${h.oldValue} -> ${h.newValue}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
