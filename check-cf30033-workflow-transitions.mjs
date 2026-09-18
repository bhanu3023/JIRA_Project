// The ticket detail page's "Move to status" dropdown filters options
// using a space-wide workflow_transitions table (fromStatusId ->
// toStatusId), completely separate from the QA queue's own configured
// queueStatuses list (which DOES include Resolved). If there's no
// transition rule from this ticket's exact current statusId to QA's
// Resolved status id, Resolved won't show in the dropdown even though
// it's a valid status. Pulls the exact ids involved to confirm.
//
// Read-only.
//
// Usage: node check-cf30033-workflow-transitions.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT id, "statusId", "spaceId", dept_statuses, current_department FROM issues WHERE cf_key = 'CF-30033' OR key = 'CF-30033'`
  );
  const issue = rows[0];
  console.log(`Ticket's real statusId column = ${issue.statusId}`);
  console.log(`current_department=${issue.current_department}`);
  console.log(`dept_statuses=${JSON.stringify(issue.dept_statuses)}`);

  const { rows: statusRow } = await pool.query(`SELECT id, name, category FROM statuses WHERE id = $1`, [issue.statusId]);
  console.log(`\nThat statusId resolves to: ${JSON.stringify(statusRow[0])}`);

  console.log('\n=== All statuses in this space named like "Resolved" (there may be duplicates with different ids) ===');
  const { rows: resolvedCandidates } = await pool.query(
    `SELECT id, name, category FROM statuses WHERE "spaceId" = $1 AND name ILIKE '%resolved%'`,
    [issue.spaceId]
  );
  for (const s of resolvedCandidates) console.log(`  id=${s.id}  name=${s.name}  category=${s.category}`);

  console.log(`\n=== Workflow transitions FROM this ticket's exact statusId (${issue.statusId}) ===`);
  const { rows: transitions } = await pool.query(
    `SELECT wt.*, s2.name AS to_name FROM workflow_transitions wt
     LEFT JOIN statuses s2 ON s2.id = wt."toStatusId"
     WHERE wt."fromStatusId" = $1`,
    [issue.statusId]
  ).catch(async (e) => {
    console.log(`  (query failed: ${e.message} -- checking table name/columns)`);
    const { rows: tables } = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%workflow%'`);
    console.log(`  Tables matching '%workflow%': ${JSON.stringify(tables)}`);
    return { rows: [] };
  });
  for (const t of transitions) console.log(`  ${JSON.stringify(t)}`);
  if (!transitions.length) console.log('  (none found -- this status has NO configured transitions out at all, or the table/column name differs)');

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
