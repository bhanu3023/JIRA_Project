// Read-only: dump the raw comment text (issue_history, field='comment') for
// CF-34598 by Sadia Shaik, so the user can visually compare it against what
// now renders in the History tab after the truncation fix.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT h.id, h."createdAt", h."newValue", u."firstName", u."lastName"
    FROM issue_history h
    JOIN issues i ON i.id = h."issueId"
    LEFT JOIN users u ON u.id = h."userId"
    WHERE (i.cf_key = 'CF-34598' OR i.key = 'CF-34598') AND h.field = 'comment'
    ORDER BY h."createdAt" ASC
  `);
  for (const r of rows) {
    console.log(`\n[${r.createdAt.toISOString()}] ${r.firstName || ''} ${r.lastName || ''}:`);
    console.log(JSON.stringify(r.newValue));
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
