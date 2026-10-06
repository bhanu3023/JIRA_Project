// Infra/QA have no dept-specific sla_definitions row, yet their tickets'
// dept_sla_log shows status:"running" and the ticket detail page would
// show an SLA card for them. Checking whether a SPACE-WIDE (dept_name IS
// NULL) catch-all SLA policy exists for this space -- computeSLAInstancesPure
// applies a dept_name=null policy to EVERY department, including ones
// with no policy of their own, which would explain this exactly.
// Read-only.
//
// Usage: node check-space-wide-sla-catchall.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: tix } = await pool.query(`SELECT "spaceId" FROM issues WHERE cf_key = 'CF-33693' LIMIT 1`);
  const spaceId = tix[0]?.spaceId;
  console.log('spaceId for CF-33693 (Infra ticket):', spaceId);

  const { rows } = await pool.query(
    `SELECT id, dept_name, name, status, "startCondition", "pauseStatuses", "stopCondition", goals, "createdAt", "updatedAt"
     FROM sla_definitions WHERE "spaceId" = $1 ORDER BY (dept_name IS NULL) DESC, dept_name`,
    [spaceId]
  );
  console.log(`\nAll sla_definitions for this space (${rows.length} total):`);
  for (const r of rows) {
    console.log(`\n--- ${r.dept_name || '(SPACE-WIDE, no dept_name)'} | status=${r.status} ---`);
    console.log(`name: ${r.name}`);
    console.log(`goals: ${JSON.stringify(r.goals)}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
