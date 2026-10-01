// Inspects the real data behind confirmed Filters-vs-MBR mismatched
// tickets (CF-31128 for Abhinandan Kumar; CF-29976/29973/27228/27177 for
// Rehan Khan) to determine whether each is the already-documented,
// intentional origin-vs-current-department difference between the two
// pages, or a genuinely new discrepancy.
//
// Read-only.
//
// Usage: node check-mismatch-tickets-detail.mjs CF-31128 CF-29976 ...

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = process.argv.slice(2);

async function main() {
  for (const key of KEYS) {
    const { rows } = await pool.query(`
      SELECT COALESCE(i.cf_key, i.key) AS key, i.current_department, i.original_dept,
             i."createdAt", i."updatedAt", i."assigneeId", au.email AS assignee_email
      FROM issues i
      LEFT JOIN users au ON au.id = i."assigneeId"
      WHERE i.cf_key = $1 OR i.key = $1
    `, [key]);
    if (!rows.length) { console.log(`${key}: NOT FOUND`); continue; }
    const r = rows[0];
    console.log(`${r.key}:`);
    console.log(`  current_department=${r.current_department}  original_dept=${r.original_dept}`);
    console.log(`  createdAt=${r.createdAt.toISOString()}  updatedAt=${r.updatedAt.toISOString()}`);
    console.log(`  live assignee=${r.assignee_email}`);

    const { rows: deptHist } = await pool.query(
      `SELECT "oldValue", "newValue", "authorName", "createdAt" FROM issue_history WHERE "issueId" = (SELECT id FROM issues WHERE cf_key=$1 OR key=$1) AND field = 'department' ORDER BY "createdAt" ASC`,
      [key]
    );
    console.log(`  department history:`);
    for (const h of deptHist) console.log(`    [${h.createdAt.toISOString()}] "${h.oldValue}" -> "${h.newValue}" (by ${h.authorName})`);
    if (!deptHist.length) console.log('    (none)');
    console.log('');
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
