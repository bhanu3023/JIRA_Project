// Read-only: how many resolved tickets currently sit in a department with
// NO active SLA policy assigned at all -- the exact class of ticket the
// computeSLAInstancesPure ordering bug affected. Confirms the blast radius
// this fix covers, beyond just the 2 tickets found by name.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: activeDepts } = await pool.query(
    `SELECT DISTINCT LOWER(dept_name) AS dept FROM sla_definitions WHERE status = 'active' AND dept_name IS NOT NULL`
  );
  const coveredDepts = new Set(activeDepts.map((r) => r.dept));
  console.log('Departments WITH an active SLA policy:', [...coveredDepts]);

  const { rows } = await pool.query(`
    SELECT i."spaceId", LOWER(i.current_department) AS dept, COUNT(*) AS cnt,
           SUM(CASE WHEN s.category = 'done' THEN 1 ELSE 0 END) AS resolved_cnt
    FROM issues i LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE i.current_department IS NOT NULL
    GROUP BY i."spaceId", LOWER(i.current_department)
    ORDER BY resolved_cnt DESC
  `);
  console.log('\nDepartments with NO active SLA policy (resolved tickets sitting there now):');
  let totalAffected = 0;
  for (const r of rows) {
    if (!coveredDepts.has(r.dept) && Number(r.resolved_cnt) > 0) {
      console.log(` - space=${r.spaceId} dept="${r.dept}": ${r.resolved_cnt} resolved / ${r.cnt} total`);
      totalAffected += Number(r.resolved_cnt);
    }
  }
  console.log(`\nTotal resolved tickets in a policy-less department: ${totalAffected}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
