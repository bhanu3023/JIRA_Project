// Read-only: is "Labels" (a configured custom field, currently not
// filterable in Filters) actually used on real tickets? If genuinely unused,
// adding a filter for it would be pointless clutter instead of a real gap.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE labels IS NOT NULL AND array_length(labels,1) > 0) AS with_labels
    FROM issues
  `);
  console.log(rows[0]);

  const { rows: sample } = await pool.query(`
    SELECT COALESCE(cf_key, key) AS key, labels FROM issues
    WHERE labels IS NOT NULL AND array_length(labels,1) > 0
    LIMIT 10
  `);
  console.log('Sample tickets with labels:', sample);

  const { rows: distinctLabels } = await pool.query(`
    SELECT DISTINCT unnest(labels) AS label FROM issues WHERE labels IS NOT NULL LIMIT 30
  `);
  console.log('Distinct label values in use:', distinctLabels.map(r => r.label));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
