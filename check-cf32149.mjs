// Inspect CF-32149's current status, department, dept_statuses snapshot,
// and status-change history to understand why it shows "Pending with L2"
// on the Filters page. Read-only.
//
// Usage: node check-cf32149.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, i.key, i.cf_key, i."statusId", s.name AS status_name, s.category AS status_category,
      i.current_department, i."assigneeId", i.dept_statuses, i.dept_assignees, i.priority, i."createdAt", i."updatedAt"
    FROM issues i
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE i.key = 'CF-32149' OR i.cf_key = 'CF-32149'
    LIMIT 1
  `);
  if (!rows.length) { console.log('Not found'); await pool.end(); return; }
  const r = rows[0];
  console.log('key:', r.key, 'cf_key:', r.cf_key);
  console.log('REAL current statusId:', r.statusId, '-> name:', r.status_name, 'category:', r.status_category);
  console.log('current_department:', r.current_department);
  console.log('assigneeId:', r.assigneeId);
  console.log('dept_statuses:', JSON.stringify(r.dept_statuses, null, 2));
  console.log('dept_assignees:', JSON.stringify(r.dept_assignees, null, 2));

  const { rows: hist } = await pool.query(`
    SELECT field, "oldValue", "newValue", "authorName", "createdAt"
    FROM issue_history
    WHERE "issueId" = $1 AND field IN ('status', 'department', 'queueStatus')
    ORDER BY "createdAt" ASC
  `, [r.id]);
  console.log('\nStatus/department history:');
  for (const h of hist) {
    console.log(`  [${h.createdAt?.toISOString?.() || h.createdAt}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" by ${h.authorName}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
