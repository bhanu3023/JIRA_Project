// CF-26109 shows Updated = 29/Sep/26 8:12 PM even though it was resolved
// back on 30/Jun/26 and nothing about it should have changed since --
// suspiciously close to when today's SLA snapshot backfill/clear work ran.
// Checking whether there's a DB trigger that bumps updatedAt on ANY row
// write (which the sla_snapshot freeze -- `UPDATE issues SET
// sla_snapshot=... WHERE id=...`, no explicit updatedAt -- would then
// silently trip), and confirming this ticket's own snapshot state.
// Read-only.
//
// Usage: node check-updatedat-trigger.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: triggers } = await pool.query(
    `SELECT trigger_name, event_manipulation, action_statement
     FROM information_schema.triggers
     WHERE event_object_table = 'issues'`
  );
  console.log('Triggers on issues table:');
  console.log(JSON.stringify(triggers, null, 2));

  const { rows } = await pool.query(
    `SELECT key, cf_key, "createdAt", "updatedAt", "resolvedAt", sla_snapshot IS NOT NULL AS has_snapshot
     FROM issues WHERE key = 'CF-26109' OR cf_key = 'CF-26109'`
  );
  console.log('\nCF-26109:', JSON.stringify(rows[0], null, 2));

  // How many OTHER resolved tickets have updatedAt suspiciously close to
  // right now (today), far past their own resolvedAt -- to gauge blast radius
  const { rows: suspicious } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM issues
     WHERE "resolvedAt" IS NOT NULL
       AND "updatedAt" > "resolvedAt" + INTERVAL '1 day'
       AND "updatedAt" > NOW() - INTERVAL '2 days'`
  );
  console.log('\nResolved tickets whose updatedAt jumped to within the last 2 days (far past their own resolvedAt):', suspicious[0].cnt);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
