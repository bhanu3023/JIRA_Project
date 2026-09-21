// CF-33269 turned out to be a SUBTASK (parentKey = L1BOAR-31588), not the
// main ticket, and its only history row is a manual Infra -> QA move by an
// admin account, not an automatic cascade. Pulling the real parent's
// (L1BOAR-31588) full department/status history and ALL its subtasks (not
// just CF-33269) to understand the actual sequence of events and whether
// any subtask's department genuinely followed the parent automatically.
//
// Read-only.
//
// Usage: node check-l1boar31588-parent-history.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: parentRows } = await pool.query(
    `SELECT id, key, cf_key, current_department, "createdAt" FROM issues WHERE key = 'L1BOAR-31588' OR cf_key = 'L1BOAR-31588'`
  );
  if (!parentRows.length) { console.log('L1BOAR-31588 not found'); await pool.end(); return; }
  const parent = parentRows[0];
  console.log(`=== L1BOAR-31588 / ${parent.cf_key} (id=${parent.id}) current_department=${parent.current_department} created=${parent.createdAt.toISOString()} ===`);

  const { rows: parentHist } = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt" FROM issue_history
     WHERE "issueId" = $1 AND field IN ('department','status') ORDER BY "createdAt" ASC`,
    [parent.id]
  );
  console.log('\nParent department/status history:');
  for (const h of parentHist) console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" (by ${h.authorName || h.authorEmail})`);

  const { rows: children } = await pool.query(
    `SELECT id, key, cf_key, current_department, "createdAt" FROM issues WHERE "parentKey" = $1 OR "parentKey" = $2 ORDER BY "createdAt" ASC`,
    [parent.key, parent.cf_key]
  );
  console.log(`\n=== All subtasks of this parent: ${children.length} ===`);
  for (const child of children) {
    console.log(`\n${child.cf_key || child.key} current_department=${child.current_department} created=${child.createdAt.toISOString()}`);
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
