// Read-only: find cases where "Actively worked (In Progress)" shows 0m for
// a department instance, yet real worklog hours were logged during that
// same window -- would mean the status-based "In Progress" heuristic is
// silently hiding genuine logged work from the SLA card, not a computation
// bug but a real gap in what the metric captures.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function computeInProgressMsInWindow(statusHistory, windowStartMs, windowEndMs) {
  if (!(windowEndMs > windowStartMs)) return 0;
  let total = 0;
  let currentStatus = null;
  let cursor = windowStartMs;
  for (const row of statusHistory) {
    const t = new Date(row.createdAt).getTime();
    if (t <= windowStartMs) { currentStatus = row.newValue; continue; }
    if (t >= windowEndMs) break;
    if ((currentStatus || '').trim().toLowerCase() === 'in progress') total += t - cursor;
    cursor = t;
    currentStatus = row.newValue;
  }
  if ((currentStatus || '').trim().toLowerCase() === 'in progress') total += windowEndMs - cursor;
  return total;
}

async function main() {
  const { rows: issues } = await pool.query(`
    SELECT id, COALESCE(cf_key, key) AS key, sla_snapshot
    FROM issues
    WHERE "resolvedAt" IS NOT NULL AND sla_snapshot IS NOT NULL
      AND jsonb_array_length(sla_snapshot) > 0
    ORDER BY "resolvedAt" DESC
    LIMIT 150
  `);

  let zeroCount = 0, zeroWithWorklog = 0;
  const examples = [];
  for (const issue of issues) {
    const [{ rows: statusHistory }, { rows: worklogs }] = await Promise.all([
      pool.query(`SELECT "newValue", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'status' ORDER BY "createdAt" ASC`, [issue.id]),
      pool.query(`SELECT department, "timeSpentMinutes" AS minutes, "workDate" AS "loggedAt" FROM issue_worklogs WHERE "issueId" = $1`, [issue.id]).catch(() => ({ rows: [] })),
    ]);
    for (const inst of issue.sla_snapshot) {
      if (!inst.startedAt || typeof inst.actualElapsedMs !== 'number' || inst.actualElapsedMs < 5 * 60000) continue;
      const startMs = new Date(inst.startedAt).getTime();
      const endMs = startMs + inst.actualElapsedMs;
      const computed = computeInProgressMsInWindow(statusHistory, startMs, endMs);
      if (computed === 0) {
        zeroCount++;
        const matchingWorklogs = worklogs.filter((w) => {
          const t = new Date(w.loggedAt).getTime();
          const deptMatch = !inst.deptName || (w.department || '').toLowerCase() === inst.deptName.toLowerCase();
          return deptMatch && t >= startMs && t <= endMs;
        });
        const totalLoggedMin = matchingWorklogs.reduce((s, w) => s + (w.minutes || 0), 0);
        if (totalLoggedMin > 0) {
          zeroWithWorklog++;
          if (examples.length < 10) {
            examples.push(`${issue.key} dept=${inst.deptName || '(space-wide)'}: 0m in-progress but ${totalLoggedMin}min logged in worklog during this window`);
          }
        }
      }
    }
  }
  console.log(`Department instances with 0m "Actively worked": ${zeroCount}`);
  console.log(`...of those, how many had real worklog minutes logged during the same window: ${zeroWithWorklog}`);
  console.log('\nExamples:');
  for (const e of examples) console.log(' - ' + e);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
