// CF-30865 and CF-33222's priority should be "high", not "highest" --
// per explicit request. Also logs the change to issue_history for an
// audit trail. Dry-run by default; --apply to write.
//
// Usage: node fix-cf30865-cf33222-priority.mjs [--apply]
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
function rid() { return 'hist_' + Math.random().toString(36).slice(2, 12); }

async function main() {
  const { rows } = await pool.query(`
    SELECT id, COALESCE(cf_key, key) AS key, priority
    FROM issues WHERE cf_key = ANY($1::text[]) OR key = ANY($1::text[])
  `, [['CF-30865', 'CF-33222']]);
  for (const r of rows) {
    console.log(`${r.key}: current priority=${r.priority}`);
    if (APPLY) {
      await pool.query(`UPDATE issues SET priority = 'high' WHERE id = $1`, [r.id]);
      await pool.query(
        `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt")
         VALUES ($1, $2, 'priority', $3, 'high', $4, $5, NOW())`,
        [rid(), r.id, r.priority, 'System (priority correction)', 'system@neutara']
      );
      console.log(`  -> updated to high`);
    }
  }
  if (!APPLY) console.log('\nDry run only -- re-run with --apply to write.');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
