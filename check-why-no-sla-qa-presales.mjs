// CF-30003 (QA) and CF-33699 (Pre-sales) show zero SLA entries at all,
// even though two space-wide policies exist ("Time to First Response",
// "Time to Resolution", no dept_name restriction, which per the policy
// filter `!pDept || pDept === issueDept` should apply to EVERY
// department). Checking the exact policy list/filter result and the
// space-wide policies' own status/pauseStatuses/stopCondition to see
// why they don't appear for these two tickets specifically. Read-only.
//
// Usage: node check-why-no-sla-qa-presales.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  for (const key of ['CF-30003', 'CF-33699']) {
    const { rows } = await pool.query(`
      SELECT i.id, i."spaceId", i.current_department, i.priority, i."statusId", s.category AS status_category, s.name AS status_name
      FROM issues i LEFT JOIN statuses s ON i."statusId" = s.id
      WHERE i.cf_key = $1 OR i.key = $1 LIMIT 1
    `, [key]);
    const issue = rows[0];
    console.log(`\n=== ${key} ===`);
    console.log('current_department:', issue.current_department, 'priority:', issue.priority, 'status:', issue.status_name, issue.status_category);

    const { rows: policies } = await pool.query(`
      SELECT id, name, dept_name, status, "pauseStatuses", "startCondition", "stopCondition"
      FROM sla_definitions WHERE "spaceId" = $1
    `, [issue.spaceId]);
    console.log('All SLA policies in this space:');
    for (const p of policies) {
      const applies = !p.dept_name || p.dept_name.toLowerCase() === (issue.current_department || '').toLowerCase();
      console.log(`  "${p.name}" dept=${p.dept_name || '(space-wide)'} status=${p.status} pauseStatuses=${JSON.stringify(p.pauseStatuses)} applies-to-this-ticket=${applies}`);
    }
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
