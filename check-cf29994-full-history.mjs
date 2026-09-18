// CF-29994's dept_statuses.Pre-sales snapshot already correctly uses
// qst_presales_open (a proper Pre-Sales queue-status id), and Pre-Sales'
// own queueTransitions config does have "Open -> Resolved" -- so this
// ticket shouldn't be affected by the same dept_statuses-contamination
// bug found on CF-29995. Pulling its full status/department history to
// see what's actually different before guessing at a second cause.
//
// Read-only.
//
// Usage: node check-cf29994-full-history.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT id, "statusId" FROM issues WHERE cf_key = 'CF-29994' OR key = 'CF-29994'`);
  const issue = rows[0];
  console.log(`Real statusId column = ${issue.statusId}`);

  const { rows: statusRow } = await pool.query(`SELECT id, name, category FROM statuses WHERE id = $1`, [issue.statusId]);
  console.log(`That resolves to: ${JSON.stringify(statusRow[0])}`);

  console.log('\n=== Status/department history ===');
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
