// Repairs CF-31525's current_department, confirmed null while its
// original_dept, dept_statuses, and full status history (To Do -> In
// Progress -> Done -> Resolved -> Done -> Resolved) all clearly show a real
// Infra ticket. Restores it to 'Infra'. Single-row, targeted fix -- prints
// before/after and verifies the row actually changed.
//
// Usage: node fix-cf31525-null-department.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = 'CF-31525';

async function main() {
  const before = await pool.query(`SELECT id, key, cf_key, current_department, original_dept FROM issues WHERE cf_key = $1 OR key = $1 LIMIT 1`, [KEY]);
  const issue = before.rows[0];
  if (!issue) { console.log(`${KEY} not found`); await pool.end(); return; }
  console.log('Before:', issue);

  if (issue.current_department !== null) {
    console.log(`current_department is already "${issue.current_department}" (not null) -- not touching it, something else may have already fixed this.`);
    await pool.end();
    return;
  }

  await pool.query(`UPDATE issues SET current_department = 'Infra' WHERE id = $1`, [issue.id]);

  const after = await pool.query(`SELECT id, key, cf_key, current_department, original_dept FROM issues WHERE id = $1`, [issue.id]);
  console.log('After:', after.rows[0]);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
