// One-off maintenance script: renames a space's technical `key` (used in
// URLs, e.g. /spaces/TESTIN) without breaking anything else that references
// it by that exact text key rather than its internal id -- custom_queues
// (space_key is its primary key) and email_configs (space_key column).
// Existing issue keys (e.g. L1BOAR-1432) are untouched -- they're independent
// strings stored per-issue, not derived from spaces.key at read time.
//
// Usage:
//   node rename-space-key.mjs OLD_KEY NEW_KEY          -- dry run, shows what would change
//   node rename-space-key.mjs OLD_KEY NEW_KEY --yes    -- actually renames
import fs from 'fs';
import { Pool } from 'pg';

for (const envFile of ['.env', '.env.server']) {
  if (process.env.DATABASE_URL || !fs.existsSync(envFile)) continue;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.*)\s*$/);
    if (m) { process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, ''); break; }
  }
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (checked .env and .env.server). Run this from the project root.');
  process.exit(1);
}

const [oldKeyArg, newKeyArg] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const confirmed = process.argv.includes('--yes');

if (!oldKeyArg || !newKeyArg) {
  console.error('Usage: node rename-space-key.mjs OLD_KEY NEW_KEY [--yes]');
  process.exit(1);
}
const oldKey = oldKeyArg.toUpperCase();
const newKey = newKeyArg.toUpperCase().replace(/[^A-Z0-9]/g, ''); // same normalization the app uses when a space is first created

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const spaceRes = await pool.query(`SELECT id, key, name FROM spaces WHERE key = $1`, [oldKey]);
  if (!spaceRes.rows.length) {
    console.log(`No space found with key "${oldKey}".`);
    await pool.end();
    return;
  }
  const space = spaceRes.rows[0];

  const clashRes = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [newKey]);
  if (clashRes.rows.length) {
    console.error(`A space with key "${newKey}" already exists -- pick a different key.`);
    await pool.end();
    process.exit(1);
  }

  const cqRes = await pool.query(`SELECT space_key FROM custom_queues WHERE space_key = $1`, [oldKey]);
  const ecRes = await pool.query(`SELECT id, address FROM email_configs WHERE space_key = $1`, [oldKey]);

  console.log(`Space: "${space.name}" (id=${space.id})`);
  console.log(`  key: "${oldKey}" -> "${newKey}"`);
  console.log(`  custom_queues row to update: ${cqRes.rows.length}`);
  console.log(`  email_configs rows to update: ${ecRes.rows.length}${ecRes.rows.length ? ' (' + ecRes.rows.map(r => r.address).join(', ') + ')' : ''}`);
  console.log(`  URL changes from /spaces/${oldKey} to /spaces/${newKey}`);

  if (!confirmed) {
    console.log('\nDry run only -- rerun with --yes to apply.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE spaces SET key = $1 WHERE key = $2`, [newKey, oldKey]);
    await client.query(`UPDATE custom_queues SET space_key = $1 WHERE space_key = $2`, [newKey, oldKey]);
    await client.query(`UPDATE email_configs SET space_key = $1 WHERE space_key = $2`, [newKey, oldKey]);
    await client.query('COMMIT');
    console.log(`\nDone. "${space.name}" is now at /spaces/${newKey}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Rename failed, rolled back:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
