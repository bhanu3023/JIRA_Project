// Read-only check for the "worked-on wrong department" bug: a generic
// 'worked' credit (jira-pg-api.ts ~line 12511) fired AFTER a department
// handoff in the same request had already flipped current_department to
// the TARGET department, crediting the acting user with the department
// they handed the ticket TO instead of the one they were actually in.
//
// Signature of a bug-created row: a 'worked' row for (user, issue) whose
// dept differs from a 'passed' row for the SAME (user, issue) written
// within a few seconds of it (performDeptHandoff's own correct credit,
// using the real FROM department) -- the 'passed' row is always right;
// the close-in-time 'worked' row with a different dept is the artifact.
//
// Usage: node check-bad-worked-dept-rows.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT w.user_id, w.issue_id, w.dept AS bad_dept, w.worked_at AS bad_at,
           p.dept AS correct_dept, p.worked_at AS passed_at,
           u.email, i.key, i.cf_key
    FROM user_worked_on_tickets w
    JOIN user_worked_on_tickets p
      ON p.user_id = w.user_id AND p.issue_id = w.issue_id AND p.dept != w.dept AND p.reason = 'passed'
    JOIN users u ON u.id = w.user_id
    JOIN issues i ON i.id = w.issue_id
    WHERE w.reason = 'worked'
      AND ABS(EXTRACT(EPOCH FROM (w.worked_at - p.worked_at))) < 10
    ORDER BY w.worked_at DESC
  `);

  console.log(`Found ${rows.length} likely bug-created 'worked' row(s):\n`);
  for (const r of rows.slice(0, 50)) {
    console.log(`${r.cf_key || r.key}  ${r.email}  bad=${r.bad_dept}@${r.bad_at.toISOString()}  correct=${r.correct_dept}@${r.passed_at.toISOString()}`);
  }
  if (rows.length > 50) console.log(`... and ${rows.length - 50} more`);

  const cf33996 = rows.filter(r => r.key === 'CF-33996' || r.cf_key === 'CF-33996');
  console.log(`\nCF-33996 specifically: ${cf33996.length} matching row(s)`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
