// CF-32756's SLA card shows something impossible: START 9:14 PM but DUE
// 9:12 PM -- the due time is BEFORE the start time, for a "(6h)" SLA
// target that should put Due 6 hours AFTER start. Checking the raw
// dept_sla_started_at/dept_sla_log/priority/resolvedAt plus the Migration
// queue's actually-configured SLA policy goals, to find where this
// nonsensical due date is coming from before touching any code.
//
// Read-only.
//
// Usage: node check-cf32756-sla-breach.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT i.key, i.cf_key, i.priority, i."statusId", i."resolvedAt", i."createdAt",
            i.current_department, i.dept_sla_started_at, i.dept_sla_log, i.dept_statuses,
            i.jira_sla_breached, i.jira_sla_due_at, i.jira_sla_start_at, i.sla_waivers,
            i."spaceId", s.name AS status_name, s.category AS status_category
     FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
     WHERE i.key = 'CF-32756' OR i.cf_key = 'CF-32756'`
  );
  const t = rows[0];
  console.log('CF-32756 raw data:');
  console.log(JSON.stringify(t, null, 2));

  // The Migration queue's configured SLA policy (sla_definitions table --
  // confirmed earlier this session as the canonical source, not the
  // denormalized copy on custom_queues)
  const { rows: slaDefs } = await pool.query(
    `SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active' ORDER BY (dept_name IS NOT NULL) DESC, "createdAt" ASC`,
    [t.spaceId]
  );
  console.log('\nActive SLA definitions for this space:');
  for (const d of slaDefs) console.log(JSON.stringify(d, null, 2));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
