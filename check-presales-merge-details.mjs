// Read-only diagnostic, follow-up to check-presales-queues.mjs: for the 146
// issues currently in current_department='Pre-Sales' (TESTIN), what other
// per-department fields reference "Pre-Sales" that a clean merge into
// Pre-Sales-Team needs to carry over, and whether any OTHER email_configs
// row (not just presalesteam@cloudfuze.com) still routes into Pre-Sales.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [SPACE_KEY]);
  const spaceId = spaceRows[0]?.id;

  const { rows: affected } = await pool.query(
    `SELECT id, key, original_dept, dept_statuses, dept_assignees, dept_sla_log, dept_sla_started_at, resolve_override_depts
     FROM issues WHERE "spaceId" = $1 AND current_department = 'Pre-Sales'`,
    [spaceId],
  );
  console.log(`Issues with current_department='Pre-Sales': ${affected.length}`);

  const origDeptCounts = {};
  let withDeptStatusesKey = 0, withDeptAssigneesKey = 0, withDeptSlaLogKey = 0, withSlaStartedAt = 0;
  let alreadyHasPreSalesTeamKeyInStatuses = 0, alreadyHasPreSalesTeamKeyInAssignees = 0;
  for (const r of affected) {
    origDeptCounts[r.original_dept || '(null)'] = (origDeptCounts[r.original_dept || '(null)'] || 0) + 1;
    const ds = r.dept_statuses || {};
    const da = r.dept_assignees || {};
    const dsl = r.dept_sla_log || {};
    if (Object.keys(ds).some(k => k.toLowerCase() === 'pre-sales')) withDeptStatusesKey++;
    if (Object.keys(da).some(k => k.toLowerCase() === 'pre-sales')) withDeptAssigneesKey++;
    if (Object.keys(dsl).some(k => k.toLowerCase() === 'pre-sales')) withDeptSlaLogKey++;
    if (Object.keys(ds).some(k => k.toLowerCase() === 'pre-sales-team')) alreadyHasPreSalesTeamKeyInStatuses++;
    if (Object.keys(da).some(k => k.toLowerCase() === 'pre-sales-team')) alreadyHasPreSalesTeamKeyInAssignees++;
    if (r.dept_sla_started_at && Object.keys(r.dept_sla_started_at).some(k => k.toLowerCase() === 'pre-sales')) withSlaStartedAt++;
  }
  console.log('original_dept distribution among these issues:', origDeptCounts);
  console.log(`dept_statuses has a "Pre-Sales" key: ${withDeptStatusesKey} (and already has "Pre-Sales-Team" key too: ${alreadyHasPreSalesTeamKeyInStatuses})`);
  console.log(`dept_assignees has a "Pre-Sales" key: ${withDeptAssigneesKey} (and already has "Pre-Sales-Team" key too: ${alreadyHasPreSalesTeamKeyInAssignees})`);
  console.log(`dept_sla_log has a "Pre-Sales" key: ${withDeptSlaLogKey}`);
  console.log(`dept_sla_started_at has a "Pre-Sales" key: ${withSlaStartedAt}`);

  const { rows: allEmailConfigs } = await pool.query(
    `SELECT address, department FROM email_configs WHERE space_key = $1 AND department ILIKE '%pre%sales%'`,
    [SPACE_KEY],
  );
  console.log('\nAll email_configs rows (this space) with a pre-sales-like department:', allEmailConfigs);

  const { rows: qct } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM queue_closed_tickets WHERE LOWER(dept_name) = 'pre-sales'`,
  );
  const { rows: idt } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM issue_dept_transitions WHERE LOWER(from_dept) = 'pre-sales' OR LOWER(to_dept) = 'pre-sales'`,
  );
  console.log(`\nqueue_closed_tickets rows referencing Pre-Sales: ${qct[0]?.cnt}`);
  console.log(`issue_dept_transitions rows referencing Pre-Sales: ${idt[0]?.cnt}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
