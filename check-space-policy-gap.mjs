// Read-only: confirm the hypothesis -- computeSLAInstancesPure's very first
// line is `if (!allPolicies.length) return [];`, BEFORE it ever looks at the
// frozen sla_snapshot. If CF-33699/CF-33837's current space has zero active
// sla_definitions rows, that would explain the real API returning sla: []
// for both, despite a perfectly good frozen snapshot sitting in the DB.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT COALESCE(i.cf_key, i.key) AS key, i."spaceId", sp.key AS space_key, sp.name AS space_name
    FROM issues i LEFT JOIN spaces sp ON sp.id = i."spaceId"
    WHERE i.cf_key = ANY($1::text[]) OR i.key = ANY($1::text[])
  `, [['CF-33699', 'CF-33837']]);
  for (const r of rows) {
    console.log(`${r.key}: spaceId=${r.spaceId} space_key=${r.space_key} space_name=${r.space_name}`);
    const { rows: defs } = await pool.query(
      `SELECT id, status, "updatedAt" FROM sla_definitions WHERE "spaceId" = $1`,
      [r.spaceId]
    );
    console.log(`  sla_definitions for this space: ${defs.length} total, ${defs.filter(d => d.status === 'active').length} active`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
