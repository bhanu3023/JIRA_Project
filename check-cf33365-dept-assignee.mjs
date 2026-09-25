// User reports CF-33365 shows assignee "Sanjana Nerella" with an "in Dev"
// badge when viewing the Dev queue in Filters, but says she's actually a
// Migration person, not Dev. The "in Dev" badge (Filters page, issue.
// assigneeIsHistorical) is meant to show THIS DEPARTMENT'S OWN historical
// assignee snapshot for the ticket (dept_assignees[Dev]), not the person's
// real team/current assignee -- checking the real stored data to see
// whether that snapshot is correct (she really was Dev's own assignee for
// this ticket at some point) or wrong (a data/display bug).
//
// Read-only.
//
// Usage: node check-cf33365-dept-assignee.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT i.id, i.key, i.cf_key, i.current_department, i.dept_assignees, i.dept_statuses,
            i."assigneeId", a.email AS assignee_email, a."firstName" AS assignee_first, a."lastName" AS assignee_last
     FROM issues i LEFT JOIN users a ON a.id = i."assigneeId"
     WHERE i.cf_key = 'CF-33365' OR i.key = 'CF-33365'`
  );
  const r = rows[0];
  if (!r) { console.log('NOT FOUND'); await pool.end(); return; }
  console.log(`current_department: ${r.current_department}`);
  console.log(`REAL current assignee: ${r.assignee_first} ${r.assignee_last} <${r.assignee_email}>`);
  console.log(`dept_assignees snapshot: ${JSON.stringify(r.dept_assignees, null, 2)}`);
  console.log(`dept_statuses snapshot: ${JSON.stringify(r.dept_statuses, null, 2)}`);

  console.log('\nFull department/assignee history:');
  const { rows: hist } = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
     WHERE "issueId" = $1 AND field IN ('department','assignee','status') ORDER BY "createdAt" ASC`,
    [r.id]
  );
  for (const h of hist) console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" (by ${h.authorName || 'system'})`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
