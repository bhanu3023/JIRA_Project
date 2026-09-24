// CF-33368's original_dept is NULL (never set at creation), and its
// earliest recorded department-history event shows "Dev" as the state
// right before its first real handoff -- so per the server's own fallback
// logic (originDepartment = original_dept || earliestDeptEvent.oldValue),
// its true origin resolves to Dev, not Migration. The ticket then bounced
// across Dev/Infra/Migration many times over ~7 hours by several different
// real people, and is now genuinely being worked in Migration by Lakshma
// Reddy (confirmed: his ONLY queue membership anywhere is Migration).
// Rather than rewrite the historical origin (Dev genuinely was first, per
// available evidence), grants Migration resolve access via the existing
// resolve_override_depts escape hatch -- same approach already used for
// Ranadeep's Migration tickets and CF-29995/CF-29994 earlier this session.
//
// Usage: node fix-cf33368-migration-override.mjs [--apply]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(
    `SELECT id, current_department, resolve_override_depts FROM issues WHERE cf_key = 'CF-33368' OR key = 'CF-33368'`
  );
  if (!rows.length) { console.log('CF-33368 not found'); await pool.end(); return; }
  const r = rows[0];
  const existing = Array.isArray(r.resolve_override_depts) ? r.resolve_override_depts : [];
  if (existing.some((d) => String(d).toLowerCase() === 'migration')) {
    console.log('Already has Migration in resolve_override_depts -- skipping');
    await pool.end();
    return;
  }
  const next = [...existing, 'Migration'];
  console.log(`current_department: ${r.current_department}`);
  console.log(`${APPLY ? 'Setting' : 'Would set'} resolve_override_depts = ${JSON.stringify(next)}`);
  if (APPLY) {
    await pool.query(`UPDATE issues SET resolve_override_depts = $1::jsonb WHERE id = $2`, [JSON.stringify(next), r.id]);
    console.log('Applied.');
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
