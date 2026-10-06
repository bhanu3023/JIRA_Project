// Inspect CF-33282's dept_assignees snapshot + current assignee/department,
// to understand exactly what per-department assignee data is already
// being captured, before deciding how the queue board's Assignee column
// should use it. Read-only.
//
// Usage: node check-cf33282-dept-assignees.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT key, cf_key, "assigneeId", current_department, dept_assignees, dept_statuses
     FROM issues WHERE key = 'CF-33282' OR cf_key = 'CF-33282' LIMIT 1`
  );
  if (!rows.length) { console.log('Not found'); await pool.end(); return; }
  const r = rows[0];
  console.log('key:', r.key, 'cf_key:', r.cf_key);
  console.log('current_department:', r.current_department);
  console.log('current assigneeId:', r.assigneeId);
  if (r.assigneeId) {
    const u = await pool.query(`SELECT id, "firstName", "lastName", email FROM users WHERE id=$1`, [r.assigneeId]);
    console.log('  -> resolves to:', u.rows[0]);
  }
  console.log('\ndept_assignees:', JSON.stringify(r.dept_assignees, null, 2));
  console.log('\ndept_statuses:', JSON.stringify(r.dept_statuses, null, 2));

  // Also pull the real worked-on ledger for this ticket, dept by dept
  const { rows: worked } = await pool.query(
    `SELECT w.dept, w.user_id, w.reason, w.created_at, u."firstName", u."lastName"
     FROM user_worked_on_tickets w
     LEFT JOIN users u ON u.id = w.user_id
     JOIN issues i ON i.id = w.issue_id
     WHERE i.key = 'CF-33282' OR i.cf_key = 'CF-33282'
     ORDER BY w.created_at ASC`
  );
  console.log('\nuser_worked_on_tickets ledger:');
  for (const w of worked) {
    console.log(`  dept=${w.dept} user=${w.firstName} ${w.lastName} (${w.user_id}) reason=${w.reason} at=${w.created_at?.toISOString?.() || w.created_at}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
