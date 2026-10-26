// Read-only: a ticket showing up under Queue=Dev (both Assignee and
// Reporter shown as "Manoj B", tagged "in Dev") is being questioned as
// actually belonging to Migration, not Dev. Dumps its full department
// history, dept_assignees snapshot, dept_sla_log, and worked-on-credit
// rows to determine whether it genuinely ever passed through Dev (in
// which case "in Dev" is correct historical-queue-view behavior) or
// whether something is wrongly attributing it to Dev.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const CF_KEY = 'CF-34234';

async function main() {
  const { rows } = await pool.query(
    `SELECT i.id, i.key, i.cf_key, i.summary, i.current_department, i.original_dept,
            i.dept_assignees, i.dept_sla_log, i.dept_statuses,
            a.id AS assignee_id, a."firstName" AS a_first, a."lastName" AS a_last, a.email AS a_email,
            r.id AS reporter_id, r."firstName" AS r_first, r."lastName" AS r_last, r.email AS r_email
     FROM issues i
     LEFT JOIN users a ON a.id = i."assigneeId"
     LEFT JOIN users r ON r.id = i."reporterId"
     WHERE i.cf_key = $1 OR i.key = $1`,
    [CF_KEY]
  );
  const t = rows[0];
  if (!t) { console.log('Not found:', CF_KEY); await pool.end(); return; }
  console.log('--- Ticket ---');
  console.log({
    key: t.key, cf_key: t.cf_key, summary: t.summary,
    current_department: t.current_department, original_dept: t.original_dept,
    assignee: `${t.a_first || ''} ${t.a_last || ''}`.trim() + ` <${t.a_email}>`,
    reporter: `${t.r_first || ''} ${t.r_last || ''}`.trim() + ` <${t.r_email}>`,
  });
  console.log('\ndept_assignees:', JSON.stringify(t.dept_assignees, null, 2));
  console.log('\ndept_sla_log:', JSON.stringify(t.dept_sla_log, null, 2));
  console.log('\ndept_statuses:', JSON.stringify(t.dept_statuses, null, 2));

  const { rows: histRows } = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorName", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field IN ('department','assignee') ORDER BY "createdAt" ASC`,
    [t.id]
  );
  console.log('\n--- Department/Assignee history ---');
  histRows.forEach((h) => console.log(`${h.createdAt} [${h.field}] ${h.oldValue} -> ${h.newValue} (by ${h.authorName})`));

  const { rows: workedRows } = await pool.query(
    `SELECT w.dept, w.reason, w.worked_at, u."firstName", u."lastName" FROM user_worked_on_tickets w LEFT JOIN users u ON u.id = w.user_id WHERE w.issue_id = $1 ORDER BY w.worked_at ASC`,
    [t.id]
  );
  console.log('\n--- user_worked_on_tickets rows ---');
  workedRows.forEach((w) => console.log(`${w.worked_at} dept=${w.dept} reason=${w.reason} user=${w.firstName} ${w.lastName}`));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
