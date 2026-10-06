// CF-30865 and CF-33222 still show Start=Due exactly after the full
// refresh ran (0 errors reported). Checking their current raw state
// directly: priority, sla_snapshot, and whether they were actually
// included in the refresh batches at all. Read-only.
//
// Usage: node check-cf30865-cf33222-current-state.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  for (const key of ['CF-30865', 'CF-33222']) {
    const { rows } = await pool.query(`
      SELECT id, cf_key, priority, sla_snapshot, dept_sla_log, "resolvedAt"
      FROM issues WHERE cf_key = $1 OR key = $1 LIMIT 1
    `, [key]);
    const r = rows[0];
    console.log(`\n=== ${key} ===`);
    console.log('priority:', r.priority);
    console.log('sla_snapshot:', JSON.stringify(r.sla_snapshot, null, 2));

    const { rows: hist } = await pool.query(`
      SELECT field, "oldValue", "newValue", "authorName", "createdAt"
      FROM issue_history WHERE "issueId" = $1 AND field = 'priority'
      ORDER BY "createdAt" ASC
    `, [r.id]);
    console.log('priority history:', JSON.stringify(hist, null, 2));
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
