// Read-only verification: replicates getNextAgent()'s exact matching logic
// (case-insensitive name match + active-agent filter) against the live
// rr_config row, WITHOUT advancing currentIndex, to confirm the next real
// email would actually resolve to an agent now.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = 'CF' OR name ILIKE '%cloudfuze board%'`);
  const spaceId = spaceRows[0]?.id;
  const { rows } = await pool.query(`SELECT departments FROM rr_config WHERE space_id = $1`, [spaceId]);
  const depts = rows[0]?.departments || [];
  console.log(`Departments now in rr_config: ${depts.map((d) => d.name).join(', ')}`);

  const dept = depts.find((d) => d.name.toUpperCase() === 'PRE-SALES-TEAM');
  if (!dept) { console.log('Still not found -- fix did not apply.'); await pool.end(); return; }

  const active = dept.agents.filter((a) => a.isActive !== false);
  const idx = (typeof dept.currentIndex === 'number' ? dept.currentIndex : 0) % active.length;
  const next = active[idx];
  console.log(`Next email would be auto-assigned to: ${next.name} (userId=${next.userId})`);
  console.log(`Full rotation (in order): ${active.map((a) => a.name).join(' -> ')}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
