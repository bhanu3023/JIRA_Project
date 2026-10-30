// Read-only: replay computeSLAInstancesPure's own isResolved + resolved-
// snapshot-shortcut logic (verbatim) against CF-33837 using the EXACT same
// query shape reports/mbr-team's slaCandidateCols uses, to find precisely
// which condition disagrees with the expected "Dev isBreached=true" result.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i.priority, i.current_department, i."spaceId",
           i."createdAt", i."updatedAt", i."resolvedAt",
           i.dept_sla_started_at, i.dept_sla_log, i.dept_statuses, i.jira_sla_breached, i.sla_waivers, i.sla_snapshot,
           i."assigneeId", s.name AS status_name, s.category AS status_category
    FROM issues i
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE i.cf_key = 'CF-33837' OR i.key = 'CF-33837'
  `);
  const row = rows[0];
  console.log('Raw row fields:');
  console.log(' status_name:', row.status_name, '| status_category:', JSON.stringify(row.status_category));
  console.log(' current_department:', JSON.stringify(row.current_department));

  // Exact replay of computeSLAInstancesPure's issue construction + isResolved
  const issue = { ...row, status: { name: row.status_name, category: row.status_category } };
  const issueDept = (issue.current_department || '').trim().toLowerCase();
  const deptStatuses = issue.dept_statuses || {};
  const deptStatusKey = Object.keys(deptStatuses).find((k) => k.toLowerCase() === issueDept);
  const deptStatusCategory = deptStatusKey ? deptStatuses[deptStatusKey]?.category : undefined;
  const deptSlaLogForResolvedCheck = issue.dept_sla_log || {};
  const deptLogKeyForResolvedCheck = Object.keys(deptSlaLogForResolvedCheck).find((k) => k.toLowerCase() === issueDept);
  const deptLogEntryForResolvedCheck = deptLogKeyForResolvedCheck ? deptSlaLogForResolvedCheck[deptLogKeyForResolvedCheck] : null;
  const deptClockGenuinelyStopped = !deptLogEntryForResolvedCheck || deptLogEntryForResolvedCheck.status !== 'running';
  const isResolved = issue.status?.category === 'done' || (deptStatusCategory === 'done' && deptClockGenuinelyStopped);
  console.log('\nissueDept:', issueDept);
  console.log('isResolved:', isResolved, '(issue.status?.category === "done":', issue.status?.category === 'done', ')');

  console.log('\nissue.sla_snapshot is array:', Array.isArray(issue.sla_snapshot), '| length:', issue.sla_snapshot?.length);
  console.log('issue.sla_snapshot !== undefined:', issue.sla_snapshot !== undefined);

  if (isResolved) {
    const existingSnapshot = issue.sla_snapshot !== undefined ? issue.sla_snapshot : null;
    console.log('\nexistingSnapshot is array && length > 0:', Array.isArray(existingSnapshot) && existingSnapshot.length > 0);
    if (Array.isArray(existingSnapshot) && existingSnapshot.length) {
      const devEntry = existingSnapshot.find((x) => (x.deptName || '').toLowerCase() === 'dev');
      console.log('Dev entry found in snapshot:', JSON.stringify(devEntry));
      const dept = 'dev';
      const breached = existingSnapshot.some((x) => x.isBreached && (x.deptName ? x.deptName.toLowerCase() === dept : false));
      console.log('FINAL breached (replaying MBR\'s own check):', breached);
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
