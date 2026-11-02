// Read-only: is Habeebunnisa Begum attributed to ANY SLA breach on
// CF-34499, across any department? Checks the frozen snapshot, every
// dept_assignees entry, and every "SLA breached" History row for her name.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, i.sla_snapshot, i.dept_assignees, i.dept_sla_log
    FROM issues i WHERE i.cf_key = 'CF-34499' OR i.key = 'CF-34499'
  `);
  const r = rows[0];

  console.log('=== dept_assignees (who holds/held each department) ===');
  console.log(JSON.stringify(r.dept_assignees, null, 2));

  console.log('\n=== Frozen snapshot, per-department breach status ===');
  for (const inst of (r.sla_snapshot || [])) {
    console.log(` - ${inst.deptName}: isBreached=${inst.isBreached}, actualElapsedMs=${inst.actualElapsedMs}, goalDurationMs=${inst.goalDurationMs}`);
  }

  const { rows: hist } = await pool.query(`
    SELECT "newValue", "createdAt" FROM issue_history
    WHERE "issueId" = $1 AND field = 'sla' AND "newValue" ILIKE '%breached%'
    ORDER BY "createdAt" ASC
  `, [r.id]);
  console.log('\n=== Every "SLA breached" History entry on this ticket ===');
  for (const h of hist) console.log(` - [${h.createdAt.toISOString()}] ${h.newValue}`);

  const mentionsHer = hist.some((h) => h.newValue.includes('Habeebunnisa'));
  console.log(`\nIs Habeebunnisa Begum named in ANY "SLA breached" entry? ${mentionsHer}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
