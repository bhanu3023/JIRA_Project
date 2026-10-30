// Read-only: list the 4 active sla_definitions for TESTIN space, to see if
// any are space-wide (dept_name null) or scoped to "Pre-Sales-Old" -- if
// none are, computeSLAInstancesPure's dept-filter (line ~2900) would leave
// `policies` empty and hit `if (!policies.length) return [];` at line 2920,
// which runs BEFORE the resolved-snapshot check at line 2994. That would
// explain CF-33699/CF-33837 losing access to their own frozen sla_snapshot
// purely because their CURRENT department has no assigned policy at all.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT id, name, dept_name, status, "updatedAt" FROM sla_definitions
    WHERE "spaceId" = 'pg_92q07qtnlz' ORDER BY status DESC, dept_name
  `);
  for (const r of rows) {
    console.log(`${r.status === 'active' ? 'ACTIVE  ' : 'inactive'} | name="${r.name}" | dept_name=${JSON.stringify(r.dept_name)} | updatedAt=${r.updatedAt.toISOString()}`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
