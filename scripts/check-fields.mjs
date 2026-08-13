import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

const r = await pool.query(`
  SELECT s.key, s.name,
    COUNT(i.id) AS total,
    COUNT(i.combination) AS has_combo,
    COUNT(i."projectManager") AS has_pm,
    COUNT(CASE WHEN i.combination IS NULL OR i.combination='' THEN 1 END) AS missing_combo,
    COUNT(CASE WHEN i."projectManager" IS NULL OR i."projectManager"='' THEN 1 END) AS missing_pm
  FROM spaces s
  LEFT JOIN issues i ON i."spaceId" = s.id
  GROUP BY s.key, s.name
  ORDER BY s.name
`);

console.log('\nSpace | Total | Has Combo | Has PM | Missing Combo | Missing PM');
console.log('-------------------------------------------------------------------');
r.rows.forEach(x => {
  console.log(`${x.key} (${x.name}) | ${x.total} | ${x.has_combo} | ${x.has_pm} | ${x.missing_combo} | ${x.missing_pm}`);
});

// Show sample tickets that already have combo/PM filled
const sample = await pool.query(`
  SELECT COALESCE(cf_key, key) AS key, summary, combination, "projectManager", current_department
  FROM issues
  WHERE (combination IS NOT NULL AND combination != '')
     OR ("projectManager" IS NOT NULL AND "projectManager" != '')
  ORDER BY "updatedAt" DESC
  LIMIT 20
`);
console.log('\nSample tickets with combo/PM filled:');
sample.rows.forEach(x => console.log(`  ${x.key} | ${x.summary?.slice(0,50)} | combo="${x.combination}" | PM="${x.projectManager}" | dept="${x.current_department}"`));

await pool.end();
