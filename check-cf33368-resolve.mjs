// CF-33368 (department=Migration, assignee=Lakshma Reddy) doesn't show
// Resolved in its status dropdown. Same canResolveHere pattern investigated
// repeatedly this session (Pre-Sales CF-29995, Ranadeep's Migration
// tickets, subtask creator-queue mismatches): canResolveHere requires
// current_department to match original_dept (or an explicit
// resolve_override_depts entry). Checks CF-33368's own values, its real
// department history, whether it's a subtask, and Lakshma Reddy's actual
// queue membership to confirm what the correct fix should be.
//
// Read-only.
//
// Usage: node check-cf33368-resolve.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT id, current_department, original_dept, resolve_override_depts, "parentKey", "assigneeId", "reporterId", "statusId"
     FROM issues WHERE cf_key = 'CF-33368' OR key = 'CF-33368'`
  );
  if (!rows.length) { console.log('CF-33368 not found'); await pool.end(); return; }
  const r = rows[0];
  console.log(`current_department: ${r.current_department}`);
  console.log(`original_dept: ${r.original_dept}`);
  console.log(`resolve_override_depts: ${JSON.stringify(r.resolve_override_depts)}`);
  console.log(`parentKey (is it a subtask?): ${r.parentKey}`);

  const currentDeptLower = String(r.current_department || '').trim().toLowerCase();
  const originLower = String(r.original_dept || '').trim().toLowerCase();
  const overrides = Array.isArray(r.resolve_override_depts) ? r.resolve_override_depts : [];
  const canResolveHere = !currentDeptLower || currentDeptLower === originLower || overrides.some((d) => String(d).trim().toLowerCase() === currentDeptLower);
  console.log(`\ncanResolveHere (server logic): ${canResolveHere}${canResolveHere ? '' : ' <-- this is why Resolved is hidden'}`);

  console.log('\nFull department/status history:');
  const { rows: hist } = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt" FROM issue_history
     WHERE "issueId" = $1 AND field IN ('department','status','created') ORDER BY "createdAt" ASC`,
    [r.id]
  );
  for (const h of hist) console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" (by ${h.authorName || h.authorEmail})`);

  const { rows: assigneeRows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [r.assigneeId]);
  const assigneeEmail = assigneeRows[0]?.email;
  console.log(`\nassignee: ${assigneeEmail}`);

  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = cqRows[0]?.queues || [];
  const { rows: userIdRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [assigneeEmail]);
  const assigneeId = userIdRows[0]?.id;
  console.log('Assignee\'s real queue membership(s):');
  for (const q of queues) {
    if (Array.isArray(q.memberIds) && q.memberIds.includes(assigneeId)) console.log(`  ${q.name}`);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
