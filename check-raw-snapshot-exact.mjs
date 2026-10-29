// Read-only: dump the EXACT raw sla_snapshot JSON for CF-33837/CF-33699,
// field-by-field, to rule out a data-shape quirk (wrong type, unexpected
// casing, missing field) that a prior summarized dump could have hidden.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT COALESCE(cf_key,key) AS key, sla_snapshot, sla_waivers, current_department
    FROM issues WHERE cf_key = ANY($1::text[]) OR key = ANY($1::text[])
  `, [['CF-33837', 'CF-33699']]);
  for (const r of rows) {
    console.log(`\n${r.key} (current_department=${r.current_department}):`);
    console.log(JSON.stringify(r.sla_snapshot, null, 2));
    console.log('sla_waivers:', JSON.stringify(r.sla_waivers));
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
