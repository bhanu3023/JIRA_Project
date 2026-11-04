// Read-only: confirm current custom_queues state for SB after the
// NO_DEPARTMENT_SPACE_KEYS fix (CreateIssueModal.tsx + seed-queues.mjs),
// and whether the stray Infra ticket (CF-34661) still exists.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const { rows } = await pool.query(`SELECT space_key, queues FROM custom_queues WHERE space_key = 'SB'`);
  console.log('custom_queues for SB:', JSON.stringify(rows, null, 2));
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
