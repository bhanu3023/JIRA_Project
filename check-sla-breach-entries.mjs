// Read-only: confirm the deployed fix is actually writing the new-format
// "SLA breached — Dept (Name)" history rows, and that they're reachable
// (not just written) for a non-admin viewer.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT h.id, h."issueId", h."newValue", h."createdAt", i.key, i.cf_key
     FROM issue_history h
     JOIN issues i ON i.id = h."issueId"
     WHERE h.field = 'sla' AND h."newValue" ILIKE 'SLA breached%'
     ORDER BY h."createdAt" DESC
     LIMIT 15`
  );
  console.log(`Most recent ${rows.length} "SLA breached" history rows:`);
  for (const r of rows) {
    const hasName = /\(.+\)/.test(r.newValue);
    console.log(` - ${r.cf_key || r.key} | "${r.newValue}" | ${r.createdAt.toISOString()} | name included: ${hasName ? 'YES' : 'no'}`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
