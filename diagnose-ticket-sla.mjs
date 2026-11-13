// Read-only: explains why a ticket's SLA panel (side bar) and the History
// tab's SLA badges are empty / missing. Both depend entirely on the `sla`
// array GET /api/issues/:key returns (computeIssueSLAsFromDb ->
// computeSLAInstancesPure in src/lib/jira-pg-api.ts). This prints every input
// that function decides on and which rule left the array empty.
//
// Usage: node diagnose-ticket-sla.mjs CF-35038
import pg from 'pg';
import fs from 'fs';

// Same parsing the app uses (src/lib/pg-pool.ts): timestamp-without-time-zone
// columns hold UTC. Without this, history times printed 5h30m early.
pg.types.setTypeParser(1114, (s) => new Date(s + 'Z'));

// Pick up DATABASE_URL from the project's .env files when the shell doesn't have it.
for (const f of ['.env', '.env.server']) {
  if (process.env.DATABASE_URL || !fs.existsSync(f)) continue;
  const m = fs.readFileSync(f, 'utf8').match(/^DATABASE_URL=(.*)$/m);
  if (m) process.env.DATABASE_URL = m[1].trim().replace(/^["']|["']$/g, '');
}

const KEY = (process.argv[2] || 'CF-35038').trim();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const lc = (s) => String(s || '').trim().toLowerCase();

function goalFor(policy, priority) {
  const goals = Array.isArray(policy.goals) ? policy.goals : [];
  for (const g of goals) {
    if (g.isPriorityGroup && Array.isArray(g.priorityRows)) {
      const row = g.priorityRows.find((r) => lc(r.priority) === priority);
      if (row && row.timeValue !== undefined && row.timeValue !== null && row.timeValue !== '') {
        return parseFloat(row.timeValue) === 0 ? 'REMOVED (0h -> no SLA for this priority)' : `${row.timeValue} ${row.timeUnit || 'hours'}`;
      }
    } else if (g.timeValue) {
      return parseFloat(g.timeValue) === 0 ? 'REMOVED (0h)' : `${g.timeValue} ${g.timeUnit || 'hours'}`;
    }
  }
  return 'no row for this priority -> 8h default';
}

async function main() {
  const { rows } = await pool.query(
    `SELECT i.*, s.name AS status_name, s.category AS status_category, sp.key AS space_key, sp.name AS space_name
       FROM issues i
       LEFT JOIN statuses s ON s.id = i."statusId"
       LEFT JOIN spaces sp ON sp.id = i."spaceId"
      WHERE i.cf_key = $1 OR i.key = $1
      LIMIT 1`,
    [KEY],
  );
  const issue = rows[0];
  if (!issue) { console.log(`No issue found for ${KEY}`); return; }

  const priority = lc(issue.priority || 'medium');
  const dept = lc(issue.current_department);
  console.log(`=== ${KEY} (internal key ${issue.key}) ===`);
  console.log(`space:              ${issue.space_key} (${issue.space_name})  spaceId=${issue.spaceId}`);
  console.log(`issue type:         ${issue.type ?? issue.issueType ?? '?'}   parentId=${issue.parentId ?? null}`);
  console.log(`status:             ${issue.status_name} [${issue.status_category}]`);
  console.log(`priority:           ${issue.priority}`);
  console.log(`current_department: ${issue.current_department}`);
  console.log(`createdAt:          ${issue.createdAt?.toISOString?.() ?? issue.createdAt}`);
  console.log(`resolvedAt:         ${issue.resolvedAt?.toISOString?.() ?? issue.resolvedAt}`);
  console.log(`dept_sla_started_at:${issue.dept_sla_started_at?.toISOString?.() ?? issue.dept_sla_started_at}`);
  console.log(`dept_sla_log:       ${JSON.stringify(issue.dept_sla_log)}`);
  console.log(`dept_statuses:      ${JSON.stringify(issue.dept_statuses)}`);
  console.log(`sla_snapshot:       ${JSON.stringify(issue.sla_snapshot)}`);
  console.log(`sla_waivers:        ${JSON.stringify(issue.sla_waivers)}`);
  console.log(`jira_sla_breached:  ${issue.jira_sla_breached}`);

  const all = await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 ORDER BY status, dept_name NULLS FIRST, name`, [issue.spaceId]);
  console.log(`\n--- SLA policies in this space (${all.rows.length}) ---`);
  for (const p of all.rows) {
    console.log(`  [${p.status}] "${p.name}" dept=${p.dept_name || '(space-wide)'}  goal@${priority}: ${goalFor(p, priority)}  pause=${JSON.stringify(p.pauseStatuses || [])}  id=${p.id}`);
  }
  const active = all.rows.filter((p) => p.status === 'active');
  const forDept = active.filter((p) => !lc(p.dept_name) || lc(p.dept_name) === dept);
  const usableForDept = forDept.filter((p) => !String(goalFor(p, priority)).startsWith('REMOVED'));
  const logDepts = Object.keys(issue.dept_sla_log || {});
  const histUsable = logDepts.filter((d) => lc(d) !== dept).flatMap((d) =>
    active.filter((p) => lc(p.dept_name) === lc(d) && !String(goalFor(p, priority)).startsWith('REMOVED')).map((p) => `${d}: ${p.name}`));

  const hist = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
      WHERE "issueId" = $1 AND field IN ('sla','status','department','priority') ORDER BY "createdAt"`,
    [issue.id],
  );
  console.log(`\n--- History (sla / status / department / priority) ---`);
  for (const h of hist.rows) console.log(`  ${h.createdAt.toISOString()}  ${h.field.padEnd(10)} ${h.oldValue ?? ''} -> ${h.newValue ?? ''}  (${h.authorName})`);

  console.log(`\n--- Verdict ---`);
  const resolved = issue.status_category === 'done';
  if (!issue.spaceId) console.log('X Ticket has no spaceId -> SLA list is always empty.');
  if (resolved && Array.isArray(issue.sla_snapshot) && issue.sla_snapshot.length) console.log('OK Resolved with a frozen sla_snapshot -> the panel should show it.');
  if (!active.length) console.log(`X Space ${issue.space_key} has NO active SLA policy -> nothing to compute.`);
  else if (!forDept.length) console.log(`X No active policy is space-wide or scoped to current department "${issue.current_department}" (policies exist only for: ${[...new Set(active.map((p) => p.dept_name || '(space-wide)'))].join(', ')}).`);
  else if (!usableForDept.length) console.log(`X Every policy for "${issue.current_department}" has priority "${issue.priority}" set to 0h (tier removed) -> no SLA card.`);
  else console.log(`OK ${usableForDept.length} active policy(ies) apply to "${issue.current_department}" at ${issue.priority}: ${usableForDept.map((p) => p.name).join(', ')}`);
  console.log(histUsable.length ? `OK Card(s) for previously visited departments: ${histUsable.join('; ')}` : 'X No card for previously visited departments (none in dept_sla_log with an active policy).');
  if (!issue.current_department) console.log('X current_department is empty -> only space-wide policies can match.');
  if (!hist.rows.some((h) => h.field === 'sla')) console.log('X No "SLA started/paused/resolved" history rows -> the SLA clock was never started for this ticket (startDeptSLA never ran: no department handoff happened).');
  if (!logDepts.length) console.log('X dept_sla_log is empty -> no department ever had its SLA clock running.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
