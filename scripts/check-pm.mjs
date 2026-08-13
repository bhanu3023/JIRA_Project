import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

const r = await pool.query(`
  SELECT "projectManager", COUNT(*) cnt
  FROM issues
  WHERE "projectManager" IS NOT NULL AND "projectManager" != '' AND "projectManager" != 'null'
  GROUP BY "projectManager"
  ORDER BY cnt DESC
  LIMIT 30
`);
console.log('Distinct projectManager values:');
r.rows.forEach(x => console.log(`  "${x.projectManager}" — ${x.cnt} tickets`));

// Also check users table for names that might match
const users = await pool.query(`SELECT id, "firstName", "lastName", email, role FROM users ORDER BY "firstName"`);
console.log('\nUsers in system:');
users.rows.forEach(u => console.log(`  ${u.firstName} ${u.lastName} (${u.email}) role=${u.role}`));

await pool.end();
