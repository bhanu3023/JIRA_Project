// CF-33040's SLA panel shows Migration/Time to Resolution, (4h) goal,
// RESOLVED (Breached), Start=createdAt (Sep16 3:34PM), Due=Start+4h,
// "Resolved in 8h34m -- past goal", "Resolved by Anush Dasari" -- but
// nobody named Anush Dasari appears anywhere in the visible history, and
// the ticket bounced Infra->Dev->Migration all within about 1 minute late
// on Sep16 11:35-11:36 PM, meaning Migration itself may have only actually
// held it for a short final stretch, not the full 8h34m charged against its
// 4h goal. Pulls dept_sla_log (the real per-department elapsed/paused
// bookkeeping) and full issue_history to check: (1) is the breach real by
// Migration's own actual elapsed time, (2) which department is really
// responsible, (3) why the actual resolve event left no history trace.
// Read-only.
//
// Usage: node check-cf33040-sla.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'CF-33040';

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, i.key, i.cf_key, i.priority, i.current_department, i."createdAt", i."resolvedAt",
           i.dept_sla_started_at, i.dept_sla_log, i.sla_snapshot, i."spaceId", i."statusId"
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
