// By explicit user request: SAT_Board is meant to be a plain
// service-desk board (matching IT ADMINISTRATION, which has no configured
// queues at all), but currently has one stray "Infra" queue -- created
// today by a teammate (Vamshi Gande), 0 members, holding one real ticket
// (CF-33655). Removing the queue entry from SAT_Board's custom_queues
// config (the same change PUT /custom-queues/SB would make from the
// queue settings page). This does NOT touch the ticket itself -- CF-33655
// keeps its current_department='Infra' value and stays fully intact and
// findable via Filters/search; it just won't have a dedicated queue page
// under SAT_Board's sidebar anymore.
//
// Dry-run by default; pass --apply to actually write.
//
// Usage: node remove-satboard-infra-queue.mjs [--apply]
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'SB'`);
  const current = rows[0]?.queues || [];
  console.log('Current SAT_Board queues:', JSON.stringify(current, null, 2));

  const next = current.filter((q) => String(q.name || '').toLowerCase() !== 'infra');
  console.log(`\nWould remove ${current.length - next.length} queue(s). Resulting queues:`, JSON.stringify(next));

  if (!APPLY) {
    console.log('\nDRY RUN -- no changes made. Re-run with --apply to actually remove it.');
    await pool.end();
    return;
  }

  await pool.query(
    `INSERT INTO custom_queues (space_key, queues, updated_at) VALUES ('SB', $1::jsonb, NOW())
     ON CONFLICT (space_key) DO UPDATE SET queues = EXCLUDED.queues, updated_at = NOW()`,
    [JSON.stringify(next)]
  );
  console.log('\nApplied. SAT_Board now has no configured queues, same as IT ADMINISTRATION.');
  console.log('CF-33655 was NOT touched -- still exists, still current_department=Infra, still findable via Filters.');

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
