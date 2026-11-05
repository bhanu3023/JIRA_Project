// Read-only: dumps the raw issue_history rows for CF-34998 to see exactly
// what's stored, since the ticket detail page's History tab showed only 1
// of the 3 entries the backfill script is expected to have written.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const { rows: issueRows } = await pool.query(`SELECT id, key, "createdAt", "updatedAt", "resolvedAt" FROM issues WHERE key = 'CF-34998'`);
  console.log('Issue:', issueRows[0]);
  const { rows: hist } = await pool.query(
    `SELECT id, field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt" FROM issue_history WHERE "issueId" = $1 ORDER BY "createdAt" DESC`,
    [issueRows[0].id],
  );
  console.log(`\n${hist.length} history row(s):`);
  for (const h of hist) console.log(JSON.stringify(h));
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
