// Read-only: why does SAT_Board (space_key likely 'SB') have an "Infra"
// custom queue? Dump its custom_queues row and any tickets actually in it,
// to see if this is leftover/misconfigured data or something genuinely
// created for this space.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: spaces } = await pool.query(
    `SELECT id, key, name FROM spaces WHERE key ILIKE '%SB%' OR name ILIKE '%SAT%'`
  );
  console.log('Matching spaces:', spaces);

  for (const sp of spaces) {
    const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [sp.key]);
    console.log(`\ncustom_queues for space_key=${sp.key}:`, JSON.stringify(cq[0]?.queues, null, 2));

    const { rows: ticketCount } = await pool.query(
      `SELECT COUNT(*) FROM issues WHERE "spaceId" = $1`,
      [sp.id]
    );
    console.log(`Total issues in this space: ${ticketCount[0].count}`);

    const { rows: deptCounts } = await pool.query(
      `SELECT current_department, COUNT(*) FROM issues WHERE "spaceId" = $1 GROUP BY current_department`,
      [sp.id]
    );
    console.log('Issues by department in this space:', deptCounts);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
