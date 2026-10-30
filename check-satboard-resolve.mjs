// Read-only: SAT_Board tickets apparently hide the "Done"/Resolved status
// option for anyone except whoever created the ticket -- user wants this
// restriction removed entirely for this board. Dumps CF-34519's own
// department/origin/reporter fields plus SAT_Board's space type and
// custom_queues config to find out exactly what's driving canResolveHere
// for a board that (per the deploy script's own department-queue check)
// has "no department/queue concept" at all.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const { rows } = await pool.query(
    `SELECT i.key, i.cf_key, i.current_department, i.original_dept, i.resolve_override_depts,
            i."reporterId", r."firstName" AS r_first, r."lastName" AS r_last,
            i."assigneeId", a."firstName" AS a_first, a."lastName" AS a_last,
            sp.id AS space_id, sp.key AS space_key, sp.name AS space_name, sp.type AS space_type
     FROM issues i
     JOIN spaces sp ON sp.id = i."spaceId"
     LEFT JOIN users r ON r.id = i."reporterId"
     LEFT JOIN users a ON a.id = i."assigneeId"
     WHERE i.cf_key = 'CF-34519' OR i.key = 'CF-34519'`
  );
  console.log('--- CF-34519 ---');
  console.log(rows[0]);

  if (rows[0]) {
    const spaceKey = rows[0].space_key;
    const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [spaceKey]);
    console.log(`\n--- custom_queues for ${spaceKey} ---`);
    console.log(cq[0] ? JSON.stringify(cq[0].queues, null, 2).slice(0, 2000) : 'NO custom_queues row at all for this space');

    const { rows: deptSample } = await pool.query(
      `SELECT current_department, COUNT(*) AS cnt FROM issues WHERE "spaceId" = $1 GROUP BY current_department ORDER BY cnt DESC`,
      [rows[0].space_id]
    );
    console.log(`\n--- Distinct current_department values across all of ${spaceKey} ---`);
    console.log(deptSample);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
