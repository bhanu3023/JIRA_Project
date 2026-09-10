// Generic: waive a specific ticket's breached SLA policy/policies.
//
// This does NOT touch the underlying dept_sla_log/elapsed-time numbers
// (computeSLAInstancesPure still sees the same history) -- it only writes a
// waiver, the exact same mechanism the ticket detail page's own "Waive this
// breach" button uses (PATCH /issues/:key/sla-waiver in src/lib/jira-pg-api.ts),
// so the audit trail (who/why/when) stays intact and
// computeSLAInstancesPure's `waiver ? false : rawIsBreached` picks it up
// automatically everywhere: the detail page, Resolution History's per-event
// "Late" badges, and the Filters-page CSV export.
//
// Run this ON the production server, where DATABASE_URL in .env.server
// actually resolves (it's bound to 127.0.0.1:5434, not reachable remotely):
//
//   node --env-file=.env.server waive-sla-breach.mjs CF-29697             # dry run
//   node --env-file=.env.server waive-sla-breach.mjs CF-29697 --apply     # writes the waiver
//
// Optional overrides:
//   WAIVED_BY_NAME="Your Name" WAIVER_REASON="..." node --env-file=.env.server waive-sla-breach.mjs CF-29697 --apply

import pg from 'pg';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const KEY = args.find((a) => !a.startsWith('--'));
if (!KEY) {
  console.error('Usage: node waive-sla-breach.mjs <CF-KEY> [--apply]');
  process.exit(1);
}

const WAIVED_BY_NAME = process.env.WAIVED_BY_NAME || 'Bhanu Srikakulam';
const REASON = process.env.WAIVER_REASON
  || 'Breach was an artifact of an admin toggling status while investigating the ticket, not a real SLA miss.';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function rid() {
  return `pg_${Math.random().toString(36).slice(2, 12)}`;
}

// Same duration-resolution logic as computeSLAInstancesPure /
// the Filters-page breach recompute in src/lib/jira-pg-api.ts.
function computeDurationMs(policy, priority) {
  let durationMs = 8 * 60 * 60 * 1000; // default 8h
  for (const goal of (policy.goals || [])) {
    if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
      const row = goal.priorityRows.find((r) => r.priority?.toLowerCase() === priority);
      if (row?.timeValue) {
        const val = parseFloat(row.timeValue);
        const unit = (row.timeUnit || 'hours').toLowerCase();
        durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
        break;
      }
    } else if (goal.timeValue) {
      const val = parseFloat(goal.timeValue);
      const unit = (goal.timeUnit || 'hours').toLowerCase();
      durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
      break;
    }
  }
  return durationMs;
}

async function main() {
  const { rows } = await pool.query(
    `SELECT id, key, cf_key, "spaceId", priority, current_department, dept_sla_log, sla_waivers, "resolvedAt"
     FROM issues WHERE key = $1 OR cf_key = $1 LIMIT 1`,
    [KEY]
  );
  const issue = rows[0];
  if (!issue) {
    console.error(`${KEY} not found.`);
    await pool.end();
    process.exit(1);
  }

  const displayKey = issue.cf_key || issue.key;
  const dept = (issue.current_department || '').trim().toLowerCase();
  const priority = (issue.priority || 'medium').toLowerCase();
  const deptSlaLog = issue.dept_sla_log || {};
  const deptLogKey = Object.keys(deptSlaLog).find((k) => k.toLowerCase() === dept);
  const priorElapsedMs = deptLogKey ? (deptSlaLog[deptLogKey].elapsed_ms || 0) : 0;

  console.log(`${displayKey} -- resolvedAt=${issue.resolvedAt}, current_department=${issue.current_department}, elapsed in that dept=${(priorElapsedMs / 3_600_000).toFixed(2)}h`);

  const { rows: policies } = await pool.query(
    `SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`,
    [issue.spaceId]
  );
  const applicable = policies.filter((p) => {
    const pDept = (p.dept_name || '').trim().toLowerCase();
    return !pDept || pDept === dept;
  });

  const waivers = issue.sla_waivers || {};
  const toWaive = [];
  for (const policy of applicable) {
    const durationMs = computeDurationMs(policy, priority);
    const breached = priorElapsedMs >= durationMs;
    const already = !!waivers[policy.id];
    console.log(
      `  Policy "${policy.name}" (${policy.id}): goal=${(durationMs / 3_600_000).toFixed(2)}h -> ${breached ? 'BREACHED' : 'ok'}${already ? ' [already waived]' : ''}`
    );
    if (breached && !already) toWaive.push(policy);
  }

  if (!toWaive.length) {
    console.log('\nNothing to waive (either not breached, or already waived). No changes made.');
    await pool.end();
    return;
  }

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to waive ${toWaive.length} polic${toWaive.length === 1 ? 'y' : 'ies'} listed above.`);
    await pool.end();
    return;
  }

  for (const policy of toWaive) {
    waivers[policy.id] = {
      waivedBy: null,
      waivedByName: WAIVED_BY_NAME,
      waivedAt: new Date().toISOString(),
      reason: REASON,
    };
  }
  await pool.query(`UPDATE issues SET sla_waivers = $1::jsonb, "updatedAt" = NOW() WHERE id = $2`, [JSON.stringify(waivers), issue.id]);

  try {
    await pool.query(
      `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail") VALUES ($1,$2,'sla',$3,$4,$5,$6)`,
      [rid(), issue.id, null, `SLA breach waived — ${REASON}`, WAIVED_BY_NAME, null]
    );
  } catch (e) {
    console.warn('issue_history log skipped:', e.message);
  }

  console.log(`\nWaived ${toWaive.length} polic${toWaive.length === 1 ? 'y' : 'ies'} on ${displayKey}. It will now read as "resolved in time" on the ticket detail page, Resolution History, and the Filters-page export.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
