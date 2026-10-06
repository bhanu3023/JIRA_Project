// User says Infra and QA have NO SLA policy configured in queue settings,
// but Filters shows "SLA Running" for their tickets. Confirming whether
// sla_definitions genuinely has no active policy for these two
// departments before looking at the code that computes "Running".
// Read-only.
//
// Usage: node check-infra-qa-sla-config.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT dept_name, name, status, goals FROM sla_definitions WHERE dept_name IN ('Infra', 'QA') ORDER BY dept_name`
  );
  console.log('sla_definitions rows for Infra/QA:');
  console.log(rows.length ? JSON.stringify(rows, null, 2) : '(none found)');

  // Sample a few Infra/QA tickets and see what the Filters "SLA Status" /
  // "SLA Running" field would actually be computed from.
  const { rows: tickets } = await pool.query(
    `SELECT key, cf_key, current_department, dept_sla_started_at, dept_sla_log, "statusId"
     FROM issues WHERE LOWER(current_department) IN ('infra', 'qa') AND "resolvedAt" IS NULL
     ORDER BY "createdAt" DESC LIMIT 5`
  );
  console.log('\nSample open Infra/QA tickets:');
  for (const t of tickets) {
    console.log(`  ${t.cf_key || t.key}: dept=${t.current_department}, dept_sla_started_at=${t.dept_sla_started_at}, dept_sla_log=${JSON.stringify(t.dept_sla_log)}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
