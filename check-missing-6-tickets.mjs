// These 6 tickets match Queue:Dev+Assignee:Pragati+Sep2026 when
// filtered directly, but are absent from the plain Queue:Dev (no
// assignee) list for the identical scope. Checking their real
// current_department, assigneeId, and dept_assignees to understand
// why the two code paths disagree. Read-only.
//
// Usage: node check-missing-6-tickets.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = ['CF-33608', 'CF-33489', 'CF-33371', 'CF-33283', 'CF-33197', 'CF-30691'];

async function main() {
  const { rows } = await pool.query(`
    SELECT COALESCE(cf_key, key) AS key, current_department, "assigneeId", dept_assignees, "createdAt", "updatedAt"
    FROM issues WHERE cf_key = ANY($1::text[]) OR key = ANY($1::text[])
  `, [KEYS]);
  for (const r of rows) {
    console.log(`${r.key}: current_department=${r.current_department} assigneeId=${r.assigneeId} created=${r.createdAt?.toISOString?.()} updated=${r.updatedAt?.toISOString?.()}`);
    console.log(`  dept_assignees: ${JSON.stringify(r.dept_assignees)}`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
