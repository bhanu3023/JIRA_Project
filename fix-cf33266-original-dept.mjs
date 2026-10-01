// CF-33266 is a sibling subtask of CF-33269 (same parent, L1BOAR-31588),
// created in the same batch while the parent was transiently sitting in
// Infra -- same original_dept bug already confirmed and fixed for
// CF-33269 (it should be QA, matching creator Asma Karim's real queue, not
// wherever the parent happened to be at that exact moment). CF-33266 was
// created before the creator-queue fix (commit 96d4339) was deployed, so
// it likely still carries the wrong value. Corrects it the same way.
//
// Usage: node fix-cf33266-original-dept.mjs [--apply]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(
    `SELECT id, current_department, original_dept, resolve_override_depts, "reporterId" FROM issues WHERE cf_key = 'CF-33266' OR key = 'CF-33266'`
  );
  if (!rows.length) { console.log('CF-33266 not found'); await pool.end(); return; }
  const r = rows[0];
  console.log(`current_department: ${r.current_department}`);
  console.log(`original_dept: ${r.original_dept}`);
  console.log(`resolve_override_depts: ${JSON.stringify(r.resolve_override_depts)}`);

  const { rows: reporterRows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [r.reporterId]);
  console.log(`reporter: ${reporterRows[0]?.email}`);

  if (String(r.current_department || '').toLowerCase() !== 'qa') {
    console.log(`\ncurrent_department is "${r.current_department}", not QA -- not applying automatically. Review before proceeding.`);
    await pool.end();
    return;
  }

  console.log(`\n${APPLY ? 'Setting' : 'Would set'} original_dept = 'QA'`);
  if (APPLY) {
    await pool.query(`UPDATE issues SET original_dept = 'QA' WHERE id = $1`, [r.id]);
    console.log('Applied.');
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
