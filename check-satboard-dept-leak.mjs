// Read-only: SAT_Board's custom_queues keeps getting a stray "Infra" queue
// recreated by seed-queues.mjs because it finds real issues in SB with
// current_department='Infra'. IA had this exact same leak before (see
// seed-queues.mjs's own comment) and was fixed by excluding it entirely.
// Check whether SAT_Board is the same case: does it have ANY genuine
// department-based tickets, or is 'Infra' the only (stray) value present?
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: space } = await pool.query(`SELECT id FROM spaces WHERE key = 'SB'`);
  const spaceId = space[0].id;

  const { rows: deptCounts } = await pool.query(`
    SELECT current_department, COUNT(*) FROM issues WHERE "spaceId" = $1 GROUP BY current_department ORDER BY COUNT(*) DESC
  `, [spaceId]);
  console.log('current_department value breakdown for SAT_Board issues:', JSON.stringify(deptCounts, null, 2));

  const { rows: infraIssues } = await pool.query(`
    SELECT COALESCE(cf_key, key) AS key, summary, "createdAt" FROM issues
    WHERE "spaceId" = $1 AND current_department = 'Infra' ORDER BY "createdAt" ASC
  `, [spaceId]);
  console.log('\nAll SAT_Board tickets with current_department=Infra:', JSON.stringify(infraIssues, null, 2));

  // Compare: does IA (already-fixed, no-department space) have ANY similar leaked tickets right now?
  const { rows: iaSpace } = await pool.query(`SELECT id FROM spaces WHERE key = 'IA'`);
  if (iaSpace[0]) {
    const { rows: iaDeptCounts } = await pool.query(`
      SELECT current_department, COUNT(*) FROM issues WHERE "spaceId" = $1 GROUP BY current_department
    `, [iaSpace[0].id]);
    console.log('\ncurrent_department breakdown for IA (already-fixed reference case):', JSON.stringify(iaDeptCounts, null, 2));
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
