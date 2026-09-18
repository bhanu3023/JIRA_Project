// Two separate requests:
// 1. CF-29982: user says the ticket itself shows no applicable SLA, but
//    Filters shows "SLA Breached: Yes" for it -- pulls the real dept,
//    policy match, dept_sla_log, and sla_waivers to see why.
// 2. CF-26919: wants updatedAt changed to match resolvedAt -- pulls
//    current values first.
//
// Read-only.
//
// Usage: node check-cf29982-cf26919.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log('=== CF-29982 ===');
  const { rows: r1 } = await pool.query(
    `SELECT id, current_department, "spaceId", "assigneeId", dept_sla_started_at, dept_sla_log,
            jira_sla_breached, sla_waivers, "resolvedAt", "updatedAt", "statusId",
            s.name AS status_name, s.category AS status_category
     FROM issues i LEFT JOIN statuses s ON i."statusId" = s.id
     WHERE i.cf_key = 'CF-29982' OR i.key = 'CF-29982'`
  );
  if (!r1.length) { console.log('NOT FOUND'); }
  else {
    const issue = r1[0];
    console.log(`current_department=${issue.current_department}  status=${issue.status_name} (${issue.status_category})`);
    console.log(`dept_sla_started_at=${issue.dept_sla_started_at?.toISOString()}`);
    console.log(`dept_sla_log=${JSON.stringify(issue.dept_sla_log)}`);
    console.log(`jira_sla_breached=${issue.jira_sla_breached}`);
    console.log(`sla_waivers=${JSON.stringify(issue.sla_waivers)}`);
    console.log(`resolvedAt=${issue.resolvedAt?.toISOString()}  updatedAt=${issue.updatedAt?.toISOString()}`);

    const { rows: policies } = await pool.query(
      `SELECT id, dept_name, status, goals FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`,
      [issue.spaceId]
    );
    console.log(`\nActive SLA policies in this space: ${policies.length}`);
    const dept = (issue.current_department || '').trim().toLowerCase();
    const applicable = policies.filter((p) => !p.dept_name || p.dept_name.trim().toLowerCase() === dept);
    console.log(`Policies applicable to dept "${issue.current_department}": ${applicable.length}`);
    for (const p of applicable) console.log(`  id=${p.id}  dept_name=${p.dept_name}  goals=${JSON.stringify(p.goals)}`);
  }

  console.log('\n=== CF-26919 ===');
  const { rows: r2 } = await pool.query(
    `SELECT id, "resolvedAt", "updatedAt", "createdAt" FROM issues WHERE cf_key = 'CF-26919' OR key = 'CF-26919'`
  );
  if (!r2.length) { console.log('NOT FOUND'); }
  else {
    const issue = r2[0];
    console.log(`createdAt=${issue.createdAt?.toISOString()}`);
    console.log(`resolvedAt=${issue.resolvedAt?.toISOString() || 'NULL'}`);
    console.log(`updatedAt=${issue.updatedAt?.toISOString()}`);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
