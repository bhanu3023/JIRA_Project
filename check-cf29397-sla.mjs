// CF-29397's SLA panel shows Migration/Time to Resolution, Start=createdAt
// (Aug 13 8:56 PM), Due=Start+10h (Aug 14 6:56 AM), "Resolved in 4h47m --
// within the SLA goal". User asks: (1) where does "2hr spent in Migration"
// come from, and (2) was paused time correctly factored into Due. Pulls the
// full picture: priority, dept_sla_log (the real per-department elapsed/
// paused bookkeeping), resolvedAt, sla_snapshot, and full issue_history, to
// answer both precisely instead of guessing from a partial screenshot.
// Read-only.
//
// Usage: node check-cf29397-sla.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'CF-29397';

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, i.key, i.cf_key, i.priority, i.current_department, i."createdAt", i."resolvedAt",
           i.dept_sla_started_at, i.dept_sla_log, i.sla_snapshot, i."spaceId"
    FROM issues i WHERE i.cf_key = $1 OR i.key = $1 LIMIT 1
  `, [KEY]);
  const issue = rows[0];
  if (!issue) { console.log(`${KEY} not found`); await pool.end(); return; }

  console.log(`=== ${KEY} ===`);
  console.log('priority:', issue.priority);
  console.log('current_department:', issue.current_department);
  console.log('createdAt:', issue.createdAt);
  console.log('resolvedAt:', issue.resolvedAt);
  console.log('dept_sla_started_at:', issue.dept_sla_started_at);
  console.log('dept_sla_log:', JSON.stringify(issue.dept_sla_log, null, 2));
  console.log('sla_snapshot:', JSON.stringify(issue.sla_snapshot, null, 2));

  const { rows: history } = await pool.query(`
    SELECT field, "oldValue", "newValue", "authorName", "createdAt"
    FROM issue_history WHERE "issueId" = $1
    ORDER BY "createdAt" ASC
  `, [issue.id]);
  console.log('\n=== FULL issue_history ===');
  for (const h of history) {
    console.log(`${h.createdAt.toISOString()} [${h.field}] "${h.oldValue}" -> "${h.newValue}" (by ${h.authorName})`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
