// The SLA panel now shows a stale "Start: Sep 18" (left over from the
// earlier accidental reopen, which my date-restore fix didn't touch) and
// a "Resolution History" with TWO entries -- Akhila/Aug 4 and a
// System/Sep 18 one from the reopen-then-reroute. User wants the Sep 18
// System entry removed and Akhila's entry changed to July 25. Pulls the
// raw dept_sla_started_at/dept_sla_log to see the exact structure before
// editing it.
//
// Read-only.
//
// Usage: node check-cf30033-sla-log.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT dept_sla_started_at, dept_sla_log, "resolvedAt", "updatedAt", "createdAt"
     FROM issues WHERE cf_key = 'CF-30033' OR key = 'CF-30033'`
  );
  const issue = rows[0];
  console.log(`dept_sla_started_at=${issue.dept_sla_started_at?.toISOString()}`);
  console.log(`resolvedAt=${issue.resolvedAt?.toISOString()}`);
  console.log(`updatedAt=${issue.updatedAt?.toISOString()}`);
  console.log(`createdAt=${issue.createdAt?.toISOString()}`);
  console.log(`\ndept_sla_log=${JSON.stringify(issue.dept_sla_log, null, 2)}`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
