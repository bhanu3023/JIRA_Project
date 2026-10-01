// Confirming the real total after the backfill, not just trusting the
// UPDATE's own rowCount (48) plus mental math (16 + 48 = 64).
//
// Read-only.
//
// Usage: node check-cloudsoft-final-count.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FROM issues WHERE "customerName" = 'cloudsoft'`
  );
  console.log(`Total tickets with customerName='cloudsoft' right now: ${rows[0].count}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
