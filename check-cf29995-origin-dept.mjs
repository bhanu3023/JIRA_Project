// The live API/DB check just confirmed CF-29995's dept_statuses snapshot AND
// Pre-Sales' own queueTransitions config are both correct (In Progress ->
// Resolved exists) -- yet the dropdown still doesn't show "Resolved". Found
// a second, independent gate in the ticket-detail GET handler
// (jira-pg-api.ts ~8595): canResolveHere is only true when
// current_department === originDepartment (or an explicit
// resolve_override_depts entry) -- "only the department that originally
// received this ticket may resolve it". The frontend (page.tsx ~501-502)
// filters OUT every done-category status (including Resolved) from
// spaceStatuses whenever canResolveHere is false, regardless of what
// queueTransitions says. If CF-29995/CF-29994's original_dept isn't
// "Pre-sales" (or their current_department casing doesn't match it), this
// would explain the missing option independently of the earlier fix.
//
// Read-only.
//
// Usage: node check-cf29995-origin-dept.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = ['CF-29995', 'CF-29994'];

async function main() {
  for (const key of KEYS) {
    const { rows } = await pool.query(
      `SELECT current_department, original_dept, resolve_override_depts FROM issues WHERE cf_key = $1 OR key = $1`,
      [key]
    );
    if (!rows.length) { console.log(`${key}: NOT FOUND`); continue; }
    const r = rows[0];
    const currentDeptLower = (r.current_department || '').trim().toLowerCase();
    const originLower = (r.original_dept || '').trim().toLowerCase();
    const overrides = Array.isArray(r.resolve_override_depts) ? r.resolve_override_depts : [];
    const canResolveHere = !currentDeptLower || currentDeptLower === originLower || overrides.some((d) => String(d).trim().toLowerCase() === currentDeptLower);
    console.log(`${key}:`);
    console.log(`  current_department = "${r.current_department}"`);
    console.log(`  original_dept      = "${r.original_dept}"`);
    console.log(`  resolve_override_depts = ${JSON.stringify(overrides)}`);
    console.log(`  => canResolveHere (server logic) = ${canResolveHere}${canResolveHere ? '' : '  <-- THIS is why Resolved is hidden'}\n`);
  }

  // Also show the oldest department-history event for each, since that's
  // the fallback origin computation when original_dept itself is null.
  console.log('=== Earliest department-history event (fallback path) ===');
  for (const key of KEYS) {
    const { rows: idRows } = await pool.query(`SELECT id FROM issues WHERE cf_key = $1 OR key = $1`, [key]);
    if (!idRows.length) continue;
    const { rows: hist } = await pool.query(
      `SELECT "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
       WHERE "issueId" = $1 AND field = 'department' ORDER BY "createdAt" ASC LIMIT 1`,
      [idRows[0].id]
    );
    console.log(`${key}: ${hist.length ? JSON.stringify(hist[0]) : '(no department history at all)'}`);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
