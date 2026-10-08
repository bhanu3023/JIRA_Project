// CF-29905's "Time to Resolution" SLA shows (10h) goal, Migration dept,
// RESOLVED (Breached), Start Aug 22 7:57 AM, Due Aug 22 5:57 PM, resolved
// 6d 18h later by Siva Kota. Reported as possibly wrong re: priority,
// start date, and due date. Checks the raw ticket data, the Migration SLA
// policy's actual configured duration for this priority, and the frozen
// snapshot, to find out what's accurate and what (if anything) is wrong.
// Read-only.
//
// Usage: node check-cf29905-sla.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'CF-29905';

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

  // The Migration "Time to Resolution" policy's own configured goal for
  // this priority -- what SHOULD the duration be.
  const { rows: policies } = await pool.query(`
    SELECT id, name, dept_name, status, goals FROM sla_definitions
    WHERE "spaceId" = $1 AND status = 'active' AND (dept_name IS NULL OR LOWER(dept_name) = 'migration')
  `, [issue.spaceId]);
  console.log('\n=== Active SLA policies for this space, Migration-applicable ===');
  for (const p of policies) {
    console.log(`"${p.name}" dept=${p.dept_name || '(space-wide)'}`);
    console.log('  goals:', JSON.stringify(p.goals));
  }

  // Full department change history for this ticket, to see exactly when
  // it entered/left Migration and whatever else.
  const { rows: history } = await pool.query(`
    SELECT field, "oldValue", "newValue", "authorName", "createdAt"
    FROM issue_history WHERE "issueId" = $1 AND field IN ('department', 'status', 'priority')
    ORDER BY "createdAt" ASC
  `, [issue.id]);
  console.log('\n=== department/status/priority history ===');
  for (const h of history) {
    console.log(`${h.createdAt.toISOString()} [${h.field}] ${h.oldValue} -> ${h.newValue} (by ${h.authorName})`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
