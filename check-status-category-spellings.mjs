// Read-only diagnostic: how many statuses (real rows) and dept_statuses
// (custom queue-status snapshots embedded on issues) use "in-progress"
// (hyphen) vs "in_progress" (underscore) for their category -- found a
// hyphenated one on CF-35078's QA status row, which would silently break
// every category === 'in_progress' comparison in the app for any ticket
// using that status.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: statusRows } = await pool.query(
    `SELECT category, COUNT(*)::int AS cnt FROM statuses GROUP BY category ORDER BY cnt DESC`,
  );
  console.log('Distinct category values in `statuses` table:');
  for (const r of statusRows) console.log(`  "${r.category}": ${r.cnt} row(s)`);

  const { rows: hyphenStatuses } = await pool.query(
    `SELECT s.id, s.name, s."spaceId", sp.key AS space_key FROM statuses s
     LEFT JOIN spaces sp ON sp.id = s."spaceId"
     WHERE s.category = 'in-progress'`,
  );
  console.log(`\nStatus rows with category='in-progress' (hyphen): ${hyphenStatuses.length}`);
  for (const r of hyphenStatuses) console.log(`  ${r.id}  "${r.name}"  space=${r.space_key}`);

  // How many issues currently have statusId pointing at one of those
  const { rows: affectedIssues } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM issues i
     JOIN statuses s ON s.id = i."statusId"
     WHERE s.category = 'in-progress'`,
  );
  console.log(`\nIssues currently on a hyphenated-category status: ${affectedIssues[0]?.cnt ?? 0}`);

  // dept_statuses embedded category spellings, across all issues
  const { rows: deptStatusRows } = await pool.query(
    `SELECT dept_statuses FROM issues WHERE dept_statuses IS NOT NULL AND dept_statuses::text != '{}'`,
  );
  const categoryCounts = {};
  for (const row of deptStatusRows) {
    const ds = row.dept_statuses || {};
    for (const dept of Object.keys(ds)) {
      const cat = ds[dept]?.category;
      if (cat) categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }
  }
  console.log('\nCategory spellings seen inside issues.dept_statuses (across all issues):');
  for (const [cat, cnt] of Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  "${cat}": ${cnt} dept-entry occurrence(s)`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
