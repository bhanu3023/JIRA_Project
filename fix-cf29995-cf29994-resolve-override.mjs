// CF-29995/CF-29994's recorded original_dept is "Dev" (their earliest
// history event is a real Dev -> Pre-sales handoff, not a two-step creation
// artifact), so canResolveHere (jira-pg-api.ts ~8595) correctly blocks
// Pre-Sales from resolving them under the "only the origin department can
// resolve" rule. Per explicit request, Pre-Sales should be able to resolve
// these two regardless -- using the existing resolve_override_depts escape
// hatch (already used elsewhere, e.g. CF-32888) instead of changing the
// origin-department rule itself, so this doesn't affect any other ticket.
//
// Usage: node fix-cf29995-cf29994-resolve-override.mjs [--apply]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const KEYS = ['CF-29995', 'CF-29994'];

async function main() {
  for (const key of KEYS) {
    const { rows } = await pool.query(
      `SELECT id, resolve_override_depts FROM issues WHERE cf_key = $1 OR key = $1`,
      [key]
    );
    if (!rows.length) { console.log(`${key}: NOT FOUND`); continue; }
    const r = rows[0];
    const existing = Array.isArray(r.resolve_override_depts) ? r.resolve_override_depts : [];
    if (existing.some((d) => String(d).trim().toLowerCase() === 'pre-sales')) {
      console.log(`${key}: already has Pre-sales in resolve_override_depts -- skipping`);
      continue;
    }
    const next = [...existing, 'Pre-sales'];
    console.log(`${key}: ${APPLY ? 'Setting' : 'Would set'} resolve_override_depts = ${JSON.stringify(next)}`);
    if (APPLY) {
      await pool.query(`UPDATE issues SET resolve_override_depts = $1::jsonb WHERE id = $2`, [JSON.stringify(next), r.id]);
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
