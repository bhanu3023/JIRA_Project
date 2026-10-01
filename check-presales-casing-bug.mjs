// getEffectiveIssueStatus (src/lib/utils.ts) looks up
// dept_statuses[current_department] with a PLAIN, case-sensitive object-key
// access -- unlike nearly everywhere else in this codebase, which
// deliberately uses case-insensitive matching for department names for
// exactly this reason. If current_department is stored as "Pre-sales" but
// the dept_statuses snapshot's own key is "Pre-Sales" (matching the queue
// config's exact name casing), the lookup silently fails, falls through to
// the raw global statusId-based status instead -- which is how CF-29995
// ended up showing status_qa_inprogress (a leftover from its trip through
// QA) as its "effective" status while sitting in Pre-Sales, and why the
// status dropdown's fromStatusId filter never matches anything in
// Pre-Sales' own queueTransitions config. Checks the real casing on both
// sides for the 2 flagged tickets.
//
// Read-only.
//
// Usage: node check-presales-casing-bug.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = ['CF-29995', 'CF-29994'];

async function main() {
  for (const key of KEYS) {
    const { rows } = await pool.query(
      `SELECT current_department, dept_statuses FROM issues WHERE cf_key = $1 OR key = $1`,
      [key]
    );
    if (!rows.length) { console.log(`${key}: NOT FOUND`); continue; }
    const r = rows[0];
    console.log(`${key}:`);
    console.log(`  current_department = "${r.current_department}"`);
    console.log(`  dept_statuses keys = ${JSON.stringify(Object.keys(r.dept_statuses || {}))}`);
    const exactMatch = (r.dept_statuses || {})[r.current_department];
    console.log(`  Exact-case lookup dept_statuses["${r.current_department}"]: ${exactMatch ? JSON.stringify(exactMatch) : 'UNDEFINED -- this is the bug'}`);
    const caseInsensitiveKey = Object.keys(r.dept_statuses || {}).find((k) => k.toLowerCase() === String(r.current_department || '').toLowerCase());
    console.log(`  Case-insensitive match would find key: "${caseInsensitiveKey}" -> ${JSON.stringify((r.dept_statuses || {})[caseInsensitiveKey])}\n`);
  }

  console.log('=== Pre-Sales queue name exact casing, per custom_queues config ===');
  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues`);
  for (const row of cq) {
    const queues = Array.isArray(row.queues) ? row.queues : [];
    for (const q of queues) {
      if (/pre.?sales/i.test(String(q?.name || ''))) console.log(`  Queue name (exact casing): "${q.name}"`);
    }
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
