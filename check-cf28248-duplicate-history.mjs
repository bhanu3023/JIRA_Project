// Read-only: dump every raw issue_history 'status' row for CF-28248 to see
// whether the 4 "Late" Resolution History entries (2 pairs of identical
// timestamps) are genuine duplicate issue_history rows, or something else
// (e.g. a timezone/formatting collision making 2 distinct rows LOOK alike).
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT h.id, h."createdAt", h."oldValue", h."newValue", h."authorName", h."authorEmail"
    FROM issue_history h
    JOIN issues i ON i.id = h."issueId"
    WHERE (i.cf_key = 'CF-28248' OR i.key = 'CF-28248') AND h.field = 'status'
    ORDER BY h."createdAt" ASC
  `);
  console.log(`Total status-change history rows: ${rows.length}\n`);
  for (const r of rows) {
    console.log(`[${r.id}] ${r.createdAt.toISOString()}  ${r.oldValue} -> ${r.newValue}  by ${r.authorName} <${r.authorEmail}>`);
  }

  // Also show the issue's own done-category statuses to confirm which
  // newValue strings enrichSlaWithResolver treats as a "resolution"
  const { rows: statusRows } = await pool.query(`
    SELECT s.name, s.category FROM statuses s
    JOIN issues i ON i."spaceId" = s."spaceId"
    WHERE (i.cf_key = 'CF-28248' OR i.key = 'CF-28248') AND s.category = 'done'
  `);
  console.log('\nDone-category statuses for this space:');
  for (const r of statusRows) console.log(` - ${r.name}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
