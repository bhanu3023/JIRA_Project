// User reports CF-33352's ticket detail page shows Department=Dev and
// Assignee=Mayank Jain, but the Filters page's "SLA Breached" attribution
// for the same ticket shows "by Anish Pitta in Dev" -- Anish Pitta being
// (per the user) an Infra person, not Dev. Checking the raw DB fields that
// feed sla_breached_by (issues.assigneeId, live-joined) and dept_assignees
// (per-department snapshot) directly, plus assignee-change history, to find
// where the two values actually diverge before touching any code.
//
// Read-only.
//
// Usage: node check-cf33352-sla-breach-attribution.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT i.id, i.key, i.cf_key, i."assigneeId", i.current_department, i.dept_assignees,
            i.department_assignee_id, i."reporterId", i."statusId", i."resolvedAt",
            u.id AS live_assignee_id, u."firstName", u."lastName", u.email AS assignee_email
     FROM issues i LEFT JOIN users u ON u.id = i."assigneeId"
     WHERE i.cf_key = 'CF-33352' OR i.key = 'CF-33352'`
  );
  const r = rows[0];
  if (!r) { console.log('NOT FOUND'); await pool.end(); return; }

  console.log(`key=${r.key} cf_key=${r.cf_key}`);
  console.log(`current_department: ${r.current_department}`);
  console.log(`issues.assigneeId (raw column): ${r.assigneeId}`);
  console.log(`live-joined assignee: ${r.firstName} ${r.lastName} <${r.assignee_email}>`);
  console.log(`department_assignee_id: ${r.department_assignee_id}`);
  console.log(`dept_assignees snapshot: ${JSON.stringify(r.dept_assignees, null, 2)}`);

  // If department_assignee_id differs from assigneeId, resolve who that user is too
  if (r.department_assignee_id && r.department_assignee_id !== r.assigneeId) {
    const { rows: deptUserRows } = await pool.query(
      `SELECT id, "firstName", "lastName", email FROM users WHERE id = $1`,
      [r.department_assignee_id]
    );
    const du = deptUserRows[0];
    console.log(`\ndepartment_assignee_id resolves to: ${du ? `${du.firstName} ${du.lastName} <${du.email}>` : 'NOT FOUND'}`);
  }

  console.log('\nAssignee-change history (issue_history, field=assignee):');
  const { rows: hist } = await pool.query(
    `SELECT "oldValue", "newValue", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'assignee' ORDER BY "createdAt" ASC`,
    [r.id]
  );
  for (const h of hist) console.log(`  ${h.createdAt.toISOString()}: "${h.oldValue}" -> "${h.newValue}"`);

  console.log('\nDepartment-change history (issue_history, field=department or current_department):');
  const { rows: deptHist } = await pool.query(
    `SELECT field, "oldValue", "newValue", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field ILIKE '%department%' ORDER BY "createdAt" ASC`,
    [r.id]
  );
  for (const h of deptHist) console.log(`  [${h.field}] ${h.createdAt.toISOString()}: "${h.oldValue}" -> "${h.newValue}"`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
