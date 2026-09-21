// User reports: main ticket (CF-33269) went Migration -> Dev -> QA (QA
// created a subtask there) -> main ticket later moved to Infra -- and the
// subtask ALSO moved to Infra, which shouldn't happen. cascadeDeptToChildren
// (jira-pg-api.ts ~1347) is already a confirmed no-op from an earlier fix
// this session, specifically to stop exactly this. Pulls CF-33269's own
// full department history, finds its real subtasks, and each subtask's own
// department history to see whether/when/how they actually moved --
// whether cascadeDeptToChildren is somehow still running, or something else
// entirely is moving the subtask.
//
// Read-only.
//
// Usage: node check-cf33269-subtask-routing.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: parentRows } = await pool.query(
    `SELECT id, key, cf_key, current_department, "parentKey" FROM issues WHERE cf_key = 'CF-33269' OR key = 'CF-33269'`
  );
  if (!parentRows.length) { console.log('CF-33269 not found'); await pool.end(); return; }
  const parent = parentRows[0];
  console.log(`=== CF-33269 (id=${parent.id}) current_department=${parent.current_department} parentKey=${parent.parentKey} ===`);

  const { rows: parentHist } = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt" FROM issue_history
     WHERE "issueId" = $1 AND field IN ('department','status') ORDER BY "createdAt" ASC`,
    [parent.id]
  );
  console.log('\nCF-33269 department/status history:');
  for (const h of parentHist) console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" (by ${h.authorName || h.authorEmail})`);

  const { rows: children } = await pool.query(
    `SELECT id, key, cf_key, current_department, "createdAt" FROM issues WHERE "parentKey" = $1 OR "parentKey" = $2 ORDER BY "createdAt" ASC`,
    [parent.key, parent.cf_key]
  );
  console.log(`\n=== Subtasks of CF-33269: ${children.length} ===`);
  for (const child of children) {
    console.log(`\n${child.cf_key || child.key} (id=${child.id}) current_department=${child.current_department} created=${child.createdAt.toISOString()}`);
    const { rows: childHist } = await pool.query(
      `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt" FROM issue_history
       WHERE "issueId" = $1 AND field IN ('department','status') ORDER BY "createdAt" ASC`,
      [child.id]
    );
    for (const h of childHist) console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" (by ${h.authorName || h.authorEmail})`);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
