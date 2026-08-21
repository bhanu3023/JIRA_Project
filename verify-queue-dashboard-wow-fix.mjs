/**
 * verify-queue-dashboard-wow-fix.mjs
 * READ-ONLY. Shows exactly how much the week-over-week graphs (SLA breach
 * rate, tickets created vs resolved, per-member workload/open) were
 * undercounting before this fix: compares the OLD cohort (tickets currently
 * sitting in this department) against the NEW cohort (tickets that ever
 * belonged to this department, via original_dept) for "created this week"
 * and "created last week".
 *
 * Run: DATABASE_URL=... node verify-queue-dashboard-wow-fix.mjs "Migration"
 */
import pg from 'pg';

pg.types.setTypeParser(1114, (str) => new Date(str + 'Z'));
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

async function main() {
  const dept = process.argv[2] || 'Migration';
  const now = Date.now();
  const thisWeekFrom = now - 7 * 86_400_000;
  const lastWeekFrom = now - 14 * 86_400_000;
  const lastWeekTo = thisWeekFrom;

  console.log(`Queue: ${dept}\n`);

  const oldCohortRes = await pool.query(
    `SELECT i.key, i."createdAt", i.current_department, i.original_dept
     FROM issues i WHERE LOWER(i.current_department) = LOWER($1)`,
    [dept]
  );
  const newCohortRes = await pool.query(
    `SELECT i.key, i."createdAt", i.current_department, i.original_dept
     FROM issues i WHERE LOWER(COALESCE(i.original_dept, i.current_department)) = LOWER($1)`,
    [dept]
  );

  const inRange = (rows, fromMs, toMs) => rows.filter((r) => {
    const c = new Date(r.createdAt).getTime();
    return c >= fromMs && c < toMs;
  });

  const oldThisWeek = inRange(oldCohortRes.rows, thisWeekFrom, now);
  const newThisWeek = inRange(newCohortRes.rows, thisWeekFrom, now);
  const oldLastWeek = inRange(oldCohortRes.rows, lastWeekFrom, lastWeekTo);
  const newLastWeek = inRange(newCohortRes.rows, lastWeekFrom, lastWeekTo);

  console.log(`"Created This Week" -- OLD (current_department only): ${oldThisWeek.length}`);
  console.log(`"Created This Week" -- NEW (original_dept, fixed):    ${newThisWeek.length}`);
  console.log(`"Created Last Week" -- OLD (current_department only): ${oldLastWeek.length}`);
  console.log(`"Created Last Week" -- NEW (original_dept, fixed):    ${newLastWeek.length}`);

  const movedAwayThisWeek = newThisWeek.filter((r) => (r.current_department || '').toLowerCase() !== dept.toLowerCase());
  const movedAwayLastWeek = newLastWeek.filter((r) => (r.current_department || '').toLowerCase() !== dept.toLowerCase());

  console.log(`\nTickets that ORIGINATED in ${dept} this week but have ALREADY moved elsewhere (previously invisible to "created this week"): ${movedAwayThisWeek.length}`);
  if (movedAwayThisWeek.length) console.log(`  Sample: ${movedAwayThisWeek.slice(0, 10).map((r) => `${r.key} (now in ${r.current_department})`).join(', ')}`);
  console.log(`Same, for last week: ${movedAwayLastWeek.length}`);
  if (movedAwayLastWeek.length) console.log(`  Sample: ${movedAwayLastWeek.slice(0, 10).map((r) => `${r.key} (now in ${r.current_department})`).join(', ')}`);

  console.log(`\nTotal net effect: the fix recovers ${(newThisWeek.length - oldThisWeek.length) + (newLastWeek.length - oldLastWeek.length)} previously-missing tickets across both weeks.`);
  console.log(`If this is 0, either no tickets moved out of ${dept} recently, or original_dept isn't reliably populated for this space -- check the sample keys above manually if that seems surprising.`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
