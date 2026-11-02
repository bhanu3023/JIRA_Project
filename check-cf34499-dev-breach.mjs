// Read-only: verify CF-34499's Dev SLA breach (shown as 23h53m spent against
// an 8h goal, "Breached by Vishal Kumar") against the real dept_sla_log data
// and the ticket's own History log.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, COALESCE(i.cf_key,i.key) AS key, i.dept_sla_log, i.priority, i."spaceId",
           i.sla_snapshot, i.dept_assignees
    FROM issues i WHERE i.cf_key = 'CF-34499' OR i.key = 'CF-34499'
  `);
  const r = rows[0];
  console.log('priority:', r.priority);
  console.log('\ndept_sla_log.Dev:', JSON.stringify(r.dept_sla_log?.Dev, null, 2));
  console.log('\ndept_assignees.Dev:', JSON.stringify(r.dept_assignees?.Dev, null, 2));

  const { rows: policies } = await pool.query(`
    SELECT name, dept_name, goals FROM sla_definitions
    WHERE "spaceId" = $1 AND LOWER(dept_name) = 'dev' AND status = 'active'
  `, [r.spaceId]);
  console.log('\nActive Dev policies:', JSON.stringify(policies, null, 2));

  const devSnap = (r.sla_snapshot || []).find((x) => (x.deptName || '').toLowerCase() === 'dev');
  console.log('\nFrozen snapshot Dev entry:', JSON.stringify(devSnap, null, 2));

  const { rows: hist } = await pool.query(`
    SELECT field, "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
    WHERE "issueId" = $1 AND (field = 'sla' OR field = 'department' OR field = 'status')
    ORDER BY "createdAt" ASC
  `, [r.id]);
  console.log('\nFull Status/Department/SLA history:');
  for (const h of hist) console.log(` - [${h.createdAt.toISOString()}] ${h.field}: ${h.oldValue} -> ${h.newValue} (${h.authorName})`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
