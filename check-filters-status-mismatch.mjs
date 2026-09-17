// Checks a list of ticket keys' REAL live status directly from the DB
// (statusId -> status name/category), to find which ones -- if any -- are
// actually done/resolved but would display as In Progress/Open on the
// Filters page. A fix for exactly this class of bug (live "done" status
// should always win over a stale department snapshot) already shipped
// earlier this session (commit 673efb6) -- this checks whether it's
// actually holding, or whether there's a new/different cause.
//
// Read-only.
//
// Usage: node check-filters-status-mismatch.mjs CF-33107 CF-33106 ...

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = process.argv.slice(2);

if (!KEYS.length) {
  console.error('Usage: node check-filters-status-mismatch.mjs <CF-KEY> [<CF-KEY> ...]');
  process.exit(1);
}

async function main() {
  for (const key of KEYS) {
    const { rows } = await pool.query(`
      SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i."statusId", s.name AS status_name, s.category AS status_category,
             i."resolvedAt", i.current_department, i.dept_statuses
      FROM issues i
      LEFT JOIN statuses s ON s.id = i."statusId"
      WHERE i.cf_key = $1 OR i.key = $1
    `, [key]);
    if (!rows.length) { console.log(`${key}: NOT FOUND`); continue; }
    const r = rows[0];
    console.log(`${r.key}: LIVE status = "${r.status_name}" (category: ${r.status_category})  resolvedAt=${r.resolvedAt ? r.resolvedAt.toISOString() : 'null'}  current_department=${r.current_department}`);
    if (r.status_category === 'done') {
      console.log(`  *** This ticket's LIVE status IS done-category -- it should NOT be showing as Open/In Progress anywhere. ***`);
      console.log(`  dept_statuses snapshot: ${JSON.stringify(r.dept_statuses)}`);
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
