// Read-only diagnostic: 167/500 of the most recent CloudFuze Board tickets
// have no assignee. getNextAgent() (rr-service.ts) returns null -- and the
// ticket stays unassigned -- if the RR config has no department whose name
// case-insensitively matches the ticket's resolved department, or if that
// department has zero active agents. This checks which of those is actually
// happening, and for which department names.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: spaceRows } = await pool.query(
    `SELECT id, key, name FROM spaces WHERE key = 'CF' OR name ILIKE '%cloudfuze board%'`,
  );
  if (!spaceRows.length) { console.log('CloudFuze Board space not found.'); await pool.end(); return; }
  const space = spaceRows[0];
  console.log(`Space: ${space.name} (${space.key}, id=${space.id})`);

  const { rows: rrRows } = await pool.query(`SELECT departments FROM rr_config WHERE space_id = $1`, [space.id]);
  if (!rrRows.length) {
    console.log('No rr_config row exists at all for this space -- every email ticket here gets no assignee.');
  } else {
    const depts = rrRows[0].departments || [];
    console.log(`\nRR config departments (${depts.length}):`);
    for (const d of depts) {
      const active = (d.agents || []).filter(a => a.isActive !== false);
      console.log(`  "${d.name}"  isDefault=${!!d.isDefault}  agents=${(d.agents || []).length}  active=${active.length}  currentIndex=${d.currentIndex}`);
    }
  }

  console.log('\n--- current_department of the last 500 tickets, null-assignee vs assigned ---');
  const { rows } = await pool.query(
    `SELECT i.current_department, COUNT(*) FILTER (WHERE i."assigneeId" IS NULL) AS null_assignee,
            COUNT(*) AS total
     FROM issues i
     WHERE i."spaceId" = $1
     AND i."createdAt" > NOW() - INTERVAL '30 days'
     GROUP BY i.current_department
     ORDER BY total DESC`,
    [space.id],
  );
  for (const r of rows) console.log(`  "${r.current_department}"  null_assignee=${r.null_assignee} / total=${r.total}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
