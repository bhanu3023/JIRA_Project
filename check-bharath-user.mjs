import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const { rows } = await pool.query(
    `SELECT id, "firstName", "lastName", email, role, "isActive" FROM users WHERE "firstName" ILIKE 'bharath%' OR email ILIKE 'bharath%'`,
  );
  console.log(rows);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
