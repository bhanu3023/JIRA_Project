// Read-only: dump SAT_Board (space key SB)'s current statuses and
// workflow_transitions, so a "Resolved" status can be added with the right
// category/order and wired into transitions from every real status.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id, key, name FROM spaces WHERE key = 'SB'`);
  const space = spaceRows[0];
  console.log('Space:', space);
  if (!space) { await pool.end(); return; }

  const { rows: statuses } = await pool.query(`SELECT id, name, category, color, "order" FROM statuses WHERE "spaceId" = $1 ORDER BY "order"`, [space.id]);
  console.log('\nStatuses:');
  statuses.forEach((s) => console.log(` - ${s.id} | "${s.name}" | category=${s.category} | order=${s.order}`));

  const { rows: transitions } = await pool.query(
    `SELECT t.id, t."fromStatusId", f.name AS from_name, t."toStatusId", tt.name AS to_name, t.name
     FROM workflow_transitions t
     JOIN statuses f ON f.id = t."fromStatusId"
     JOIN statuses tt ON tt.id = t."toStatusId"
     WHERE t."spaceId" = $1`,
    [space.id]
  );
  console.log('\nTransitions:');
  transitions.forEach((t) => console.log(` - ${t.from_name} -> ${t.to_name} (${t.name || 'unnamed'})`));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
