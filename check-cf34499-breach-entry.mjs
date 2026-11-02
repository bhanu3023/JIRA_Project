import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const { rows } = await pool.query(`SELECT id FROM issues WHERE "cf_key"='CF-34499' OR key='CF-34499'`);
  const id = rows[0].id;
  const { rows: hist } = await pool.query(
    `SELECT field, "newValue", "createdAt" FROM issue_history WHERE "issueId"=$1 AND field='sla' ORDER BY "createdAt" ASC`,
    [id]
  );
  for (const h of hist) console.log(`[${h.createdAt.toISOString()}] ${h.newValue}`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
