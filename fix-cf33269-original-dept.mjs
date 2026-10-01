// CF-33269 is the specific ticket flagged: created by Sadia Shaik
// (qa_engineer, sole queue membership = TESTIN's QA queue) while the parent
// happened to be in Infra, so it got original_dept="Infra" -- locking QA
// out of resolving it via canResolveHere (current_department must match
// original_dept). Its current_department is already "QA" (manually moved
// there earlier while investigating this). Corrects original_dept to match
// where it should have started, per the just-deployed creator-queue fix.
//
// Usage: node fix-cf33269-original-dept.mjs [--apply]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(
    `SELECT id, current_department, original_dept, resolve_override_depts FROM issues WHERE cf_key = 'CF-33269' OR key = 'CF-33269'`
  );
  if (!rows.length) { console.log('CF-33269 not found'); await pool.end(); return; }
  const r = rows[0];
  console.log(`current_department: ${r.current_department}`);
  console.log(`original_dept: ${r.original_dept}`);
  console.log(`resolve_override_depts: ${JSON.stringify(r.resolve_override_depts)}`);

  if (String(r.current_department || '').toLowerCase() !== 'qa') {
    console.log(`\ncurrent_department is "${r.current_department}", not QA -- not applying automatically (something changed since this was last checked). Review before proceeding.`);
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
