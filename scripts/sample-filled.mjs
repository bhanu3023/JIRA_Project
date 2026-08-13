import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

const r = await pool.query(`
  SELECT COALESCE(cf_key, key) AS key, summary, combination, "projectManager"
  FROM issues
  WHERE (combination IS NOT NULL AND combination != '' AND combination != 'null')
    AND ("projectManager" IS NOT NULL AND "projectManager" != '' AND "projectManager" != 'null')
  ORDER BY "updatedAt" DESC
  LIMIT 10
`);

console.log('Tickets with BOTH combination and projectManager filled:');
r.rows.forEach(x => console.log(`  ${x.key} | combo="${x.combination}" | PM="${x.projectManager}" | ${x.summary?.slice(0,50)}`));

await pool.end();
