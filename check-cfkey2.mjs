import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const { rows } = await pool.query(
    `SELECT key, cf_key, summary, "createdAt", emailthreadid, current_department, "reporterId"
     FROM issues WHERE cf_key = 'CF-34380' OR key IN ('L2B-34378', 'PSM-2185')
     ORDER BY "createdAt"`
  );
  console.log('Full picture:', rows);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
