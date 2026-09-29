// CF-33655 is the one ticket left with department-tracking fields set to
// "Infra" after SAT_Board's Infra queue config was removed -- its SLA
// card still shows an actively "running" clock labeled Infra because that
// lives in dept_sla_log/dept_sla_started_at/dept_statuses, separate from
// current_department. Confirmed the real pattern against 3 actual
// IT ADMINISTRATION tickets (a plain service_desk board with zero
// configured queues, same as SAT_Board now): current_department=null,
// dept_sla_log={}, dept_statuses={}, dept_sla_started_at=null.
// original_dept is left AS-IS ("Infra") -- IA-10 shows a real ticket with
// original_dept still set while current_department is null, so that's a
// legitimate historical-origin value, not something that needs clearing.
//
// Dry-run by default; pass --apply to actually write.
//
// Usage: node fix-cf33655-clear-infra-department.mjs [--apply]
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: before } = await pool.query(
    `SELECT key, current_department, dept_sla_started_at, dept_sla_log, dept_statuses FROM issues WHERE key = 'CF-33655'`
  );
  console.log('Before:', JSON.stringify(before[0], null, 2));

  if (!APPLY) {
    console.log('\nWould set: current_department=NULL, dept_sla_started_at=NULL, dept_sla_log={}, dept_statuses={}');
    console.log('DRY RUN -- no changes made. Re-run with --apply to actually fix it.');
    await pool.end();
    return;
  }

  await pool.query(
    `UPDATE issues
     SET current_department = NULL,
         dept_sla_started_at = NULL,
         dept_sla_log = '{}'::jsonb,
         dept_statuses = '{}'::jsonb,
         "updatedAt" = NOW()
     WHERE key = 'CF-33655'`
  );

  const { rows: after } = await pool.query(
    `SELECT key, current_department, dept_sla_started_at, dept_sla_log, dept_statuses FROM issues WHERE key = 'CF-33655'`
  );
  console.log('\nApplied. After:', JSON.stringify(after[0], null, 2));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
