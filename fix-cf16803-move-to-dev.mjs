// One-off data fix for CF-16803. Confirmed via direct query: this ticket's
// spaceId points to a space keyed "TESTIN" -- an umbrella space whose OWN
// sub_board_keys lists CBBOARD (CloudFuze Board) and nine other boards as
// ITS children -- not the other way around. Filters only ever searches the
// currently-selected space plus THAT space's own configured sub-boards, so
// a ticket physically stored under TESTIN is invisible from CloudFuze
// Board's Filters (Queue: Migration or any other queue) no matter what its
// department says. Confirmed clean data otherwise: current_department was
// exactly "Migration" (no whitespace/case issue), status already Resolved.
//
// Per explicit instruction: move this ticket into CloudFuze Board's own
// space AND change its department to Dev (not Migration), then set
// dept_statuses["Dev"] to Dev's own configured "Resolved" queue status (not
// just carry over Migration's) so the ticket page and Filters agree.
//
// Usage:
//   node fix-cf16803-move-to-dev.mjs           # dry run
//   node fix-cf16803-move-to-dev.mjs --apply   # writes the change

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const TICKET = 'CF-16803';
const TARGET_SPACE_KEY = 'CBBOARD';
const TARGET_DEPT = 'Dev';

async function main() {
  const { rows: issueRows } = await pool.query(
    `SELECT id, cf_key, key, "spaceId", current_department, dept_statuses, dept_assignees, "statusId"
     FROM issues WHERE cf_key = $1`, [TICKET]
  );
  if (!issueRows.length) { console.log(`${TICKET} not found.`); await pool.end(); return; }
  const issue = issueRows[0];

  const { rows: spaceRows } = await pool.query(`SELECT id, key FROM spaces WHERE key = $1`, [TARGET_SPACE_KEY]);
  if (!spaceRows.length) { console.log(`Target space "${TARGET_SPACE_KEY}" not found -- aborting, nothing changed.`); await pool.end(); return; }
  const targetSpaceId = spaceRows[0].id;

  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [TARGET_SPACE_KEY]);
  const queues = cqRows[0]?.queues || [];
  const devQueue = queues.find((q) => String(q?.name || '').trim().toLowerCase() === TARGET_DEPT.toLowerCase());
  const devResolvedStatus = (devQueue?.queueStatuses || []).find((s) => s.category === 'done');

  console.log(`--- ${TICKET} (${issue.key}) ---`);
  console.log('Current:');
  console.log(`  spaceId:            ${issue.spaceId}`);
  console.log(`  current_department: ${issue.current_department}`);
  console.log(`  dept_statuses:      ${JSON.stringify(issue.dept_statuses)}`);
  console.log('');
  console.log('Proposed:');
  console.log(`  spaceId            -> ${targetSpaceId}  (${TARGET_SPACE_KEY})`);
  console.log(`  current_department -> ${TARGET_DEPT}`);
  if (devResolvedStatus) {
    console.log(`  dept_statuses["${TARGET_DEPT}"] -> ${JSON.stringify(devResolvedStatus)}`);
  } else {
    console.log(`  WARNING: no done-category status found in ${TARGET_DEPT}'s own queue config in custom_queues for ${TARGET_SPACE_KEY} -- dept_statuses["${TARGET_DEPT}"] will be left untouched. Check the Dev queue's workflow setup.`);
  }

  if (!APPLY) {
    console.log('\nDry run only -- no changes made. Re-run with --apply to write this change.');
    await pool.end();
    return;
  }

  const deptStatuses = issue.dept_statuses || {};
  if (devResolvedStatus) {
    deptStatuses[TARGET_DEPT] = { id: devResolvedStatus.id, name: devResolvedStatus.name, category: devResolvedStatus.category, color: devResolvedStatus.color };
  }

  await pool.query(
    `UPDATE issues SET "spaceId"=$1, current_department=$2, dept_statuses=$3::jsonb, "updatedAt"=NOW() WHERE id=$4`,
    [targetSpaceId, TARGET_DEPT, JSON.stringify(deptStatuses), issue.id]
  );
  await pool.query(
    `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt")
     VALUES (gen_random_uuid()::text, $1, 'department', $2, $3, 'Manual data fix', 'bhanu.srikakulam@cloudfuze.com', NOW())`,
    [issue.id, `${issue.current_department} (space TESTIN)`, `${TARGET_DEPT} (space ${TARGET_SPACE_KEY}) -- moved from TESTIN, was invisible to CloudFuze Board Filters`]
  ).catch(() => {});

  console.log(`\nUpdated ${TICKET}.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
