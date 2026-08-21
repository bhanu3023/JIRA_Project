/**
 * check-dept-filter-index.mjs
 * READ-ONLY. The Queue Dashboard's two heavy per-department queries
 * (deptIssuesRes / originDeptIssuesRes in src/lib/jira-pg-api.ts, ~line 8891
 * and ~8971) filter with `WHERE LOWER(current_department) = LOWER($1)` and
 * NO spaceId in the filter. The only index on that column,
 * idx_issues_space_dept_lower ON issues ("spaceId", LOWER(current_department)),
 * is led by spaceId, so it can't serve a department-only filter -- Postgres
 * likely falls back to a sequential scan of the whole `issues` table (15k+
 * rows for Dev). This checks that directly instead of guessing.
 *
 * Run: DATABASE_URL=... node check-dept-filter-index.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

async function explain(label, sql, params) {
  const t0 = Date.now();
  const r = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
  const wall = Date.now() - t0;
  const text = r.rows.map(row => row['QUERY PLAN']).join('\n');
  const hasSeqScan = /Seq Scan/i.test(text);
  const execMatch = text.match(/Execution Time: ([\d.]+) ms/);
  console.log(`\n--- ${label} ---`);
  console.log(text);
  console.log(`>>> wall=${wall}ms exec=${execMatch ? execMatch[1] + 'ms' : '?'} ${hasSeqScan ? '⚠️  SEQ SCAN PRESENT' : '✓ no seq scan'}`);
}

async function main() {
  const deptCounts = await pool.query(`SELECT current_department, count(*) FROM issues GROUP BY current_department ORDER BY count(*) DESC LIMIT 10`);
  console.log('=== Ticket counts per department ===');
  for (const r of deptCounts.rows) console.log(`  ${r.current_department}: ${r.count}`);

  await explain(
    'deptIssuesRes-shape query for Dev (current holdings)',
    `SELECT i.id, i.key FROM issues i WHERE LOWER(i.current_department) = LOWER('Dev')`
  );
  await explain(
    'originDeptIssuesRes-shape query for Dev (ever belonged, COALESCE)',
    `SELECT i.id, i.key FROM issues i WHERE LOWER(COALESCE(i.original_dept, i.current_department)) = LOWER('Dev')`
  );
  await explain(
    'deptIssuesRes-shape query for Migration (current holdings)',
    `SELECT i.id, i.key FROM issues i WHERE LOWER(i.current_department) = LOWER('Migration')`
  );

  console.log('\n=== Existing indexes on issues table ===');
  const idx = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'issues' ORDER BY indexname`);
  for (const r of idx.rows) console.log(`  ${r.indexname}: ${r.indexdef}`);

  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
