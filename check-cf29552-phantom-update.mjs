// Read-only: CF-29552 was created and resolved in August 2026, but
// "updatedAt" now reads 28/Oct/26 -- with NOTHING in its History tab to
// explain why. Find what (if anything) actually changed around that
// timestamp, and check whether the issues table has an auto-bump trigger
// on updatedAt that fires even on writes that don't touch anything a human
// would consider "a real update" (e.g. an internal SLA snapshot recompute).
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT id, COALESCE(cf_key,key) AS key, "createdAt", "updatedAt", "resolvedAt",
           current_department, sla_snapshot
    FROM issues WHERE cf_key = 'CF-29552' OR key = 'CF-29552'
  `);
  const row = rows[0];
  console.log('createdAt:', row.createdAt, '| updatedAt:', row.updatedAt, '| resolvedAt:', row.resolvedAt);
  console.log('current_department:', row.current_department);

  // Any issue_history row at all near the mystery updatedAt timestamp?
  const { rows: nearby } = await pool.query(`
    SELECT field, "oldValue", "newValue", "authorName", "createdAt"
    FROM issue_history WHERE "issueId" = $1
      AND "createdAt" BETWEEN $2::timestamptz - interval '2 hours' AND $2::timestamptz + interval '2 hours'
    ORDER BY "createdAt" ASC
  `, [row.id, row.updatedAt]);
  console.log(`\nHistory rows within +/-2h of updatedAt (${row.updatedAt.toISOString()}):`, nearby.length);
  for (const r of nearby) console.log(` - [${r.createdAt.toISOString()}] ${r.field}: ${r.oldValue} -> ${r.newValue} by ${r.authorName}`);

  // Does the issues table (or a trigger) auto-bump updatedAt on ANY column
  // write, even one unrelated to real user-visible content?
  const { rows: triggers } = await pool.query(`
    SELECT tgname, pg_get_triggerdef(oid) AS def
    FROM pg_trigger
    WHERE tgrelid = 'issues'::regclass AND NOT tgisinternal
  `);
  console.log('\nTriggers on the issues table:', triggers.length);
  for (const t of triggers) console.log(` - ${t.tgname}: ${t.def}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
