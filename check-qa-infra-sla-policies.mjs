// Read-only check: does this space have active, dept-scoped SLA policies
// configured for QA and Infra? If not, no SLA card can ever be generated
// for those departments, regardless of how much real time a ticket spent
// there -- a Queue Settings configuration gap, not a code bug.
//
// Usage: node check-qa-infra-sla-policies.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: issueRows } = await pool.query(`SELECT "spaceId" FROM issues WHERE key='CF-34076' OR cf_key='CF-34076' LIMIT 1`);
  const spaceId = issueRows[0]?.spaceId;
  console.log('spaceId:', spaceId);

  const { rows } = await pool.query(
    `SELECT id, name, dept_name, status, "updatedAt" FROM sla_definitions WHERE "spaceId" = $1 ORDER BY dept_name, "updatedAt" DESC`,
    [spaceId]
  );
  console.log(`\nAll SLA definitions for this space (${rows.length} total):`);
  for (const r of rows) console.log(`  [${r.status}] dept=${r.dept_name || '(space-wide)'}  name="${r.name}"  id=${r.id}`);

  const byDept = new Set(rows.filter(r => r.status === 'active').map(r => (r.dept_name || '').trim().toLowerCase()));
  console.log('\nDepartments with at least one ACTIVE policy:', Array.from(byDept).join(', ') || '(none)');
  console.log('QA has an active policy:', byDept.has('qa'));
  console.log('Infra has an active policy:', byDept.has('infra'));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
