// Read-only: confirm CF-29552's corrected updatedAt, and whether it still
// falls inside the Oct 26-30 2026 filter range that originally surfaced it.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT COALESCE(cf_key,key) AS key, "createdAt", "updatedAt", "resolvedAt"
    FROM issues WHERE cf_key = 'CF-29552' OR key = 'CF-29552'
  `);
  const r = rows[0];
  console.log('createdAt:', r.createdAt.toISOString());
  console.log('updatedAt (corrected):', r.updatedAt.toISOString());
  console.log('resolvedAt:', r.resolvedAt ? r.resolvedAt.toISOString() : null);

  const from = new Date('2026-10-26T00:00:00+05:30');
  const to = new Date('2026-10-30T23:59:59.999+05:30');
  const inRange = (r.createdAt >= from && r.createdAt <= to) || (r.updatedAt >= from && r.updatedAt <= to);
  console.log(`\nFilter range: ${from.toISOString()} -> ${to.toISOString()}`);
  console.log('Would still match Created-OR-Updated filter for this range:', inRange);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
