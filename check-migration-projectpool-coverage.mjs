// User wants ENT total + SMB total to sum EXACTLY to Filters' Migration
// total, no overlap -- the current roster-inferred classification
// deliberately double-counts ambiguous tickets (unassigned, or assigned to
// someone outside both rosters) on both tabs. A cleaner, deterministic
// alternative: Migration tickets carry their own productPool/projectPool
// field (ENT or SMB) directly -- if its coverage is complete (or near-
// complete) for Sep 2026's Migration tickets, classifying ENT/SMB from that
// field instead of roster inference would give every ticket exactly one
// bucket, summing exactly to the Filters total by construction. Checks
// exact coverage and value distribution before deciding. Read-only.
//
// Usage: node check-migration-projectpool-coverage.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const DATE_FROM = '2026-09-01';
const DATE_TO = '2026-09-30';

async function main() {
  const { rows } = await pool.query(`
    SELECT i."projectPool", COUNT(*) AS cnt
    FROM issues i
    WHERE LOWER(i.current_department) = 'migration'
      AND (i."createdAt"::date BETWEEN $1 AND $2 OR i."updatedAt"::date BETWEEN $1 AND $2)
    GROUP BY i."projectPool"
    ORDER BY cnt DESC
  `, [DATE_FROM, DATE_TO]);

  console.log(`=== Migration tickets (Sep 2026) grouped by pool/type field ===`);
  let total = 0;
  for (const r of rows) {
    console.log(`  ${JSON.stringify(r)}`);
    total += parseInt(r.cnt, 10);
  }
  console.log(`\nTotal: ${total}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
