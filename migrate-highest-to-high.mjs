// Bulk-converts every ticket with priority='highest' to 'high', system-
// wide (3,146 tickets confirmed: Dev 2997, Pre-Sales 49+15, Migration
// 40, QA 35, Infra 9, 1 unset dept). Logs each change to issue_history.
// Also strips the "highest" priorityRow entirely (not just zeroing it)
// from every sla_definitions policy's goals JSON, and from the
// denormalized custom_queues.queues[].slaPolicies copy, so Settings
// stops showing a Highest row anywhere. Dry-run by default; --apply.
//
// Usage: node migrate-highest-to-high.mjs [--apply]
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
function rid() { return 'hist_' + Math.random().toString(36).slice(2, 12); }

async function main() {
  // 1. Bulk-update issues
  const { rows: issues } = await pool.query(`SELECT id, COALESCE(cf_key, key) AS key, priority FROM issues WHERE LOWER(priority) = 'highest'`);
  console.log(`Found ${issues.length} tickets with priority=highest.`);
  if (APPLY) {
    for (const issue of issues) {
      await pool.query(`UPDATE issues SET priority = 'high' WHERE id = $1`, [issue.id]);
      await pool.query(
        `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt")
         VALUES ($1, $2, 'priority', $3, 'high', $4, $5, NOW())`,
        [rid(), issue.id, issue.priority, 'System (Highest priority removed)', 'system@neutara']
      );
    }
    console.log(`Applied: updated ${issues.length} tickets to priority=high.`);
  }

  // 2. Strip "highest" row from sla_definitions.goals
  const { rows: policies } = await pool.query(`SELECT id, name, dept_name, goals FROM sla_definitions`);
  let policiesChanged = 0;
  for (const p of policies) {
    const goals = p.goals || [];
    let changed = false;
    for (const g of goals) {
      if (g.isPriorityGroup && Array.isArray(g.priorityRows)) {
        const before = g.priorityRows.length;
        g.priorityRows = g.priorityRows.filter((r) => r.priority?.toLowerCase() !== 'highest');
        if (g.priorityRows.length !== before) changed = true;
      }
    }
    if (changed) {
      policiesChanged++;
      console.log(`  would strip "highest" row from [${p.dept_name || 'space-wide'}] "${p.name}" (${p.id})`);
      if (APPLY) await pool.query(`UPDATE sla_definitions SET goals = $1::jsonb WHERE id = $2`, [JSON.stringify(goals), p.id]);
    }
  }
  console.log(`${policiesChanged} sla_definitions policies ${APPLY ? 'updated' : 'would be updated'}.`);

  // 3. Strip "highest" row from custom_queues.queues[].slaPolicies (denormalized Settings copy)
  const { rows: cqRows } = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  for (const row of cqRows) {
    const queues = row.queues || [];
    let rowChanged = false;
    for (const q of queues) {
      for (const policy of (q.slaPolicies || [])) {
        const before = (policy.goals || []).length;
        policy.goals = (policy.goals || []).filter((g) => g.priority?.toLowerCase() !== 'highest');
        if (policy.goals.length !== before) rowChanged = true;
      }
    }
    if (rowChanged) {
      console.log(`  would strip "highest" from custom_queues space=${row.space_key}`);
      if (APPLY) await pool.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [JSON.stringify(queues), row.space_key]);
    }
  }

  if (!APPLY) console.log('\nDry run only -- re-run with --apply to write all of the above.');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
