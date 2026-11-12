// Read-only verification for merge-presales-into-presales-team.mjs.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [SPACE_KEY]);
  const spaceId = spaceRows[0]?.id;

  const { rows: counts } = await pool.query(
    `SELECT current_department, COUNT(*)::int AS cnt FROM issues
     WHERE "spaceId" = $1 AND current_department ILIKE '%pre%sales%'
     GROUP BY current_department`,
    [spaceId],
  );
  console.log('current_department counts (pre-sales-like):', counts);

  const { rows: origDeptMismatch } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM issues
     WHERE "spaceId" = $1 AND current_department = 'Pre-Sales-Team'
       AND original_dept IS DISTINCT FROM current_department
       AND key LIKE 'PSM-%'`,
    [spaceId],
  );
  console.log('Moved PSM- issues where original_dept != current_department (should be 0):', origDeptMismatch[0]?.cnt);

  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  let queues = cqRows[0]?.queues || [];
  if (typeof queues === 'string') { try { queues = JSON.parse(queues); } catch {} }
  console.log('\nQueue names remaining:', queues.map((q) => q.name));
  console.log('"Pre-Sales" (exact) still present?', queues.some((q) => q.name === 'Pre-Sales'));
  console.log('"Pre-Sales-Team" still present?', queues.some((q) => q.name === 'Pre-Sales-Team'));
  console.log('"Pre-Sales-Old" still present?', queues.some((q) => q.name === 'Pre-Sales-Old'));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
