// Filters: Queue: Infra + Status: [In Progress, Open] still shows Resolved
// tickets (CF-29644, CF-29640, CF-29592, CF-29589, CF-29550, CF-29493 from
// the screenshot). Checking each one's real statusId-derived name,
// dept_statuses['Infra'] snapshot, current_department, and assignee vs
// Infra's configured queue membership, to see exactly which SQL clause is
// letting them through. Read-only.
//
// Usage: node check-infra-status-filter-leak.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const keys = ['CF-29644', 'CF-29640', 'CF-29592', 'CF-29589', 'CF-29550', 'CF-29493'];
  const { rows } = await pool.query(
    `SELECT i.key, i.cf_key, i."assigneeId", i.current_department, i.dept_statuses,
            s.name AS real_status_name, s.category AS real_status_category
     FROM issues i LEFT JOIN statuses s ON s."id" = i."statusId"
     WHERE i.cf_key = ANY($1::text[]) OR i.key = ANY($1::text[])`,
    [keys]
  );
  for (const r of rows) {
    console.log(`\n${r.cf_key || r.key}:`);
    console.log(`  current_department: ${r.current_department}`);
    console.log(`  real status (via statusId): "${r.real_status_name}" (category: ${r.real_status_category})`);
    console.log(`  dept_statuses: ${JSON.stringify(r.dept_statuses)}`);
    console.log(`  assigneeId: ${r.assigneeId}`);
  }

  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const infra = (cq[0]?.queues || []).find(q => (q.name || '').toLowerCase() === 'infra');
  console.log(`\nInfra queue memberIds count: ${infra?.memberIds?.length}`);
  for (const r of rows) {
    console.log(`  ${r.cf_key || r.key} assignee is Infra member: ${infra?.memberIds?.includes(r.assigneeId)}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
