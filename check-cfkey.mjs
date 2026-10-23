import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const { rows } = await pool.query(
    `SELECT key, cfkey, summary FROM issues WHERE key = 'L2B-34378'`
  ).catch(async (e) => {
    console.log('cfkey column query failed (maybe different casing):', e.message);
    return { rows: [] };
  });
  console.log('By real key L2B-34378:', rows);

  const { rows: byCf } = await pool.query(
    `SELECT key, cfkey, summary FROM issues WHERE cfkey = 'CF-34380'`
  ).catch((e) => { console.log('query 2 failed:', e.message); return { rows: [] }; });
  console.log('By cfkey CF-34380:', byCf);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
