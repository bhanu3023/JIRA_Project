// User expected CF-32756's Start/Due display to visibly change after the
// SLA-freeze fix, which was never the intent -- the fix freezes whatever
// value is currently computed (so it can't drift on a future policy edit),
// it doesn't correct the historical display. Checking whether sla_snapshot
// actually got written for this ticket yet (via viewing it, or the
// backfill script), and confirming it now matches the live-computed value.
//
// Read-only.
//
// Usage: node check-cf32756-snapshot-state.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT key, cf_key, sla_snapshot FROM issues WHERE key = 'CF-32756' OR cf_key = 'CF-32756'`
  );
  const t = rows[0];
  console.log(`CF-32756 sla_snapshot: ${t.sla_snapshot ? 'SET' : 'NOT SET YET'}`);
  if (t.sla_snapshot) {
    console.log(JSON.stringify(t.sla_snapshot, null, 2));
  } else {
    console.log('Nothing frozen yet -- either the deploy hasn\'t happened, or this ticket hasn\'t been viewed/backfilled since.');
  }

  const { rows: totalCheck } = await pool.query(
    `SELECT COUNT(*) AS total_resolved,
            COUNT(*) FILTER (WHERE sla_snapshot IS NOT NULL) AS frozen
     FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
     WHERE (s.category = 'done' OR i.dept_statuses::text ILIKE '%"category":"done"%')`
  );
  console.log(`\nSystem-wide: ${totalCheck[0].frozen} of ${totalCheck[0].total_resolved} resolved tickets have a frozen snapshot.`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
