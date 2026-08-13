// Diagnostic script: prints the raw SLA policy config plus, for a given
// ticket, exactly what the due-date calculation computes from it -- so a
// mismatch between "configured 12h for Highest" and "actual due date" can be
// pinpointed instead of guessed at.
//
// Usage:
//   node debug-sla-config.mjs <ISSUE_KEY>       (e.g. node debug-sla-config.mjs CF-29283)
import fs from 'fs';
import { Pool } from 'pg';

for (const envFile of ['.env', '.env.server']) {
  if (process.env.DATABASE_URL || !fs.existsSync(envFile)) continue;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.*)\s*$/);
    if (m) { process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, ''); break; }
  }
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (checked .env and .env.server). Run this from the project root.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const issueKey = process.argv[2];

async function main() {
  const polRes = await pool.query(
    `SELECT sd.id, sd.name, sd.dept_name, sd.status, sd.goals, s.key AS space_key
     FROM sla_definitions sd LEFT JOIN spaces s ON s.id = sd."spaceId"
     WHERE sd.status = 'active' ORDER BY s.key, sd.name`
  );
  console.log(`=== Active SLA policies (${polRes.rows.length}) ===`);
  for (const p of polRes.rows) {
    console.log(`\n[${p.space_key || '?'}] "${p.name}" (id=${p.id}, dept=${p.dept_name || '<all depts>'})`);
    console.log(JSON.stringify(p.goals, null, 2));
  }

  if (!issueKey) {
    console.log('\n(pass an issue key, e.g. `node debug-sla-config.mjs CF-29283`, to also see the computed due date for a specific ticket)');
    await pool.end();
    return;
  }

  const issRes = await pool.query(
    `SELECT id, key, cf_key, priority, "spaceId", current_department, dept_sla_started_at, "createdAt"
     FROM issues WHERE key = $1 OR cf_key = $1 LIMIT 1`,
    [issueKey.toUpperCase()]
  );
  const issue = issRes.rows[0];
  if (!issue) {
    console.log(`\nNo issue found for key "${issueKey}".`);
    await pool.end();
    return;
  }
  console.log(`\n=== Issue ${issue.cf_key || issue.key} ===`);
  console.log(`priority: ${issue.priority}, department: ${issue.current_department}`);
  console.log(`dept_sla_started_at: ${issue.dept_sla_started_at}, createdAt: ${issue.createdAt}`);

  const applicable = polRes.rows.filter(p => {
    const dept = (p.dept_name || '').trim().toLowerCase();
    return !dept || dept === (issue.current_department || '').trim().toLowerCase();
  });

  const priority = (issue.priority || 'medium').toLowerCase();
  const startedAt = issue.dept_sla_started_at || issue.createdAt;

  for (const p of applicable) {
    console.log(`\n--- Policy "${p.name}" applied to this issue ---`);
    const goals = Array.isArray(p.goals) ? p.goals : [];
    let durationMs = 8 * 60 * 60 * 1000;
    let matchedFrom = 'default (8h) -- NO goal in this policy matched this priority';
    for (const goal of goals) {
      if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
        console.log(`  goal is priority-grouped. rows: ${JSON.stringify(goal.priorityRows)}`);
        const row = goal.priorityRows.find(r => (r.priority || '').toLowerCase() === priority);
        if (row?.timeValue) {
          const val = parseFloat(row.timeValue);
          const unit = (row.timeUnit || 'hours').toLowerCase();
          durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
          matchedFrom = `priority row match: priority="${row.priority}" timeValue=${row.timeValue} timeUnit=${row.timeUnit}`;
          break;
        } else {
          console.log(`  no row matched priority "${priority}" (or its timeValue is empty) -- falling through to next goal, if any`);
        }
      } else if (goal.timeValue) {
        const val = parseFloat(goal.timeValue);
        const unit = (goal.timeUnit || 'hours').toLowerCase();
        durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
        matchedFrom = `flat goal: timeValue=${goal.timeValue} timeUnit=${goal.timeUnit}`;
        break;
      }
    }
    const dueTime = new Date(new Date(startedAt).getTime() + durationMs);
    console.log(`  RESOLVED FROM: ${matchedFrom}`);
    console.log(`  durationMs = ${durationMs} (${(durationMs / 3_600_000).toFixed(2)}h)`);
    console.log(`  computed due date = ${dueTime.toISOString()} (${dueTime.toLocaleString()})`);
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
