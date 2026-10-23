import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  // Find CF-34380 case-insensitively / with possible whitespace issues
  const { rows: cfLike } = await pool.query(
    `SELECT key, summary, "createdAt", emailthreadid, current_department FROM issues WHERE key ILIKE '%34380%' OR key ILIKE 'CF-%' AND "createdAt" > '2026-10-22' ORDER BY "createdAt" DESC LIMIT 10`
  );
  console.log('Tickets matching 34380 or recent CF-:', cfLike);

  // All tickets sharing the same subject, regardless of key prefix
  const { rows: bySubject } = await pool.query(
    `SELECT key, summary, "createdAt", emailthreadid, current_department, "reporterId" FROM issues WHERE summary = 'This is Testing mail for ticketing' ORDER BY "createdAt"`
  );
  console.log('\nAll tickets with this exact subject:', bySubject);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
