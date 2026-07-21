import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });
const r = await pool.query(`SELECT id FROM issues ORDER BY "createdAt" DESC LIMIT 10`);
console.log('Sample IDs:');
r.rows.forEach(x => console.log(' ', x.id));
await pool.end();
