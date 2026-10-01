// CF-29739's SLA panel shows "Resolved in 1m" for Dev -- but the ticket
// bounced Dev -> Migration -> Dev before that final 1-minute stint. The
// detail page's "Resolved in Xm" text is computed as resolvedAt minus the
// LATEST dept_sla_started_at only (see issues/[issueKey]/page.tsx ~4488),
// NOT the accumulated dept_sla_log.elapsed_ms the breach-detection logic
// elsewhere in this app already uses for exactly this "bounced back to the
// same dept" scenario (the CF-29552 fix). Pulls the real numbers to see
// whether real earlier Dev work time is being hidden by this display.
//
// Read-only.
//
// Usage: node check-cf29739-sla-display.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT id, dept_sla_started_at, dept_sla_log, "resolvedAt", current_department
     FROM issues WHERE cf_key = 'CF-29739' OR key = 'CF-29739'`
  );
  const issue = rows[0];
  console.log(`current_department=${issue.current_department}`);
  console.log(`dept_sla_started_at (latest stint start)=${issue.dept_sla_started_at?.toISOString()}`);
  console.log(`resolvedAt=${issue.resolvedAt?.toISOString()}`);
  console.log(`dept_sla_log=${JSON.stringify(issue.dept_sla_log, null, 2)}`);

  const latestStintMs = issue.resolvedAt.getTime() - issue.dept_sla_started_at.getTime();
  console.log(`\nLatest-stint-only elapsed (what "Resolved in Xm" shows): ${Math.round(latestStintMs / 60000)}m`);

  const devLog = issue.dept_sla_log?.Dev || issue.dept_sla_log?.dev;
  if (devLog?.elapsed_ms) {
    const totalMs = devLog.elapsed_ms + latestStintMs;
    console.log(`Prior accumulated Dev elapsed_ms from dept_sla_log: ${Math.round(devLog.elapsed_ms / 60000)}m`);
    console.log(`TRUE total Dev time across both stints: ${Math.round(totalMs / 60000)}m`);
  } else {
    console.log('No prior accumulated Dev elapsed_ms found in dept_sla_log for this ticket.');
  }

  console.log('\n=== Full department/status history for context ===');
  const { rows: hist } = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
     WHERE "issueId" = $1 AND field IN ('status','department') ORDER BY "createdAt" ASC`,
    [issue.id]
  );
  for (const h of hist) console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" (by ${h.authorName})`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
