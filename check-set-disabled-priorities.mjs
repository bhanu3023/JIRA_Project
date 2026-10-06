// Checks the current disabled_priorities app_settings value, and
// (with --apply) sets it to include "highest" -- the proper, already-
// built mechanism (GET/PUT /disabled-priorities) that every Priority
// PICKER app-wide (Create ticket, ticket detail Priority field,
// subtask creation, board inline quick-edit) already respects via
// getSelectablePriorities(). This is the real fix for "remove Highest
// everywhere it can be selected" -- existing tickets still display it
// correctly (PriorityIcon's own PRIORITIES stays untouched), only new
// selections are blocked. Dry-run by default; --apply to write.
//
// Usage: node check-set-disabled-priorities.mjs [--apply]
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = 'disabled_priorities'`);
  let current = [];
  try { current = rows[0] ? JSON.parse(rows[0].value) : []; } catch {}
  console.log('Current disabled_priorities:', JSON.stringify(current));

  const next = Array.from(new Set([...current, 'highest']));
  console.log('Would set to:', JSON.stringify(next));

  if (APPLY) {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('disabled_priorities', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(next)]
    );
    console.log('Applied.');
  } else {
    console.log('\nDry run only -- re-run with --apply to write.');
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
