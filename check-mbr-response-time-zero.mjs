// User reports MBR's "Avg. response time" showing 0:00:00 for some people,
// suspecting it's not computed accurately. computeResponseTimeHours
// (jira-pg-api.ts ~2363) measures from dept_sla_started_at to the FIRST
// status-history row whose newValue is an IN_PROGRESS_STATUS_NAMES match
// ("in progress"/"work in progress"). This session already found a real,
// separate bug elsewhere (the worked-credit downgrade investigation):
// arriving in a new department can auto-reset a ticket's status in the SAME
// instant as the handoff, writing a status-history row at (or extremely
// close to) the exact same timestamp as dept_sla_started_at. If that
// auto-reset status happens to be "In Progress", computeResponseTimeHours
// would read that as an instant 0-minute human response, which isn't real.
// Finds real tickets across the whole system where the response-time gap is
// exactly (or almost) zero, and prints the full status/department history
// around dept_sla_started_at to see whether it's a genuine instant status
// change by a person, or the arrival-reset artifact.
//
// Read-only.
//
// Usage: node check-mbr-response-time-zero.mjs [--dept=Dev] [--limit=8]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const IN_PROGRESS_NAMES = new Set(['in progress', 'work in progress']);
const deptArg = (process.argv.find(a => a.startsWith('--dept=')) || '').split('=')[1];
const limit = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || 8);

function computeResponseTimeHours(statusHist, deptStartedAt) {
  if (!deptStartedAt) return null;
  const startMs = new Date(deptStartedAt).getTime();
  for (const h of statusHist) {
    if (!IN_PROGRESS_NAMES.has(String(h.newValue || '').trim().toLowerCase())) continue;
    const t = new Date(h.createdAt).getTime();
    if (t < startMs) continue;
    return { hours: Math.round(((t - startMs) / 3_600_000) * 10) / 10, atMs: t, diffMs: t - startMs };
  }
  return null;
}

async function main() {
  const { rows: issues } = await pool.query(
    `SELECT id, cf_key, key, current_department, dept_sla_started_at
     FROM issues
     WHERE dept_sla_started_at IS NOT NULL
     AND ($1::text IS NULL OR LOWER(current_department) = LOWER($1))
     ORDER BY "updatedAt" DESC LIMIT 500`,
    [deptArg || null]
  );

  let checked = 0, zeroCount = 0;
  for (const issue of issues) {
    const { rows: hist } = await pool.query(
      `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt" FROM issue_history
       WHERE "issueId" = $1 ORDER BY "createdAt" ASC`,
      [issue.id]
    );
    const statusHist = hist.filter(h => h.field === 'status');
    const result = computeResponseTimeHours(statusHist, issue.dept_sla_started_at);
    checked++;
    if (!result || result.hours > 0.02) continue; // only near-zero cases (~<1 min)
    zeroCount++;
    if (zeroCount > limit) continue;

    console.log(`\n=== ${issue.cf_key || issue.key} (dept=${issue.current_department}) -- response time = ${result.hours}h (diff ${result.diffMs}ms) ===`);
    console.log(`dept_sla_started_at: ${new Date(issue.dept_sla_started_at).toISOString()}`);
    console.log('Full history around that time:');
    for (const h of hist) {
      const t = new Date(h.createdAt).getTime();
      const near = Math.abs(t - new Date(issue.dept_sla_started_at).getTime()) < 5000;
      console.log(`  ${near ? '>>' : '  '}[${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" (by ${h.authorName || h.authorEmail || 'system'})`);
    }
  }
  console.log(`\nChecked ${checked} tickets with dept_sla_started_at set; ${zeroCount} had a near-zero response time (showing up to ${limit}).`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
