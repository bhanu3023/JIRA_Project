// One-off maintenance script: removes the leftover "tsa" and "testing" SLA
// policies that were left active with no department scope, so they were
// silently applying to every ticket in their space alongside whatever SLA
// was actually configured for that ticket's queue (e.g. "Time to Resolution").
//
// Usage (run on the server, where DATABASE_URL points at the real DB):
//   node cleanup-sla-policies.mjs            -- lists matching policies only
//   node cleanup-sla-policies.mjs --yes      -- actually deletes them
import fs from 'fs';
import { Pool } from 'pg';

// Load DATABASE_URL from .env in the current directory if it's not already
// set in the environment -- avoids depending on the `dotenv` package being
// installed on whatever host this script is run from.
if (!process.env.DATABASE_URL && fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.*)\s*$/);
    if (m) { process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, ''); break; }
  }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (checked .env in the current directory). Run this from the project root.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const TARGET_NAMES = ['tsa', 'testing'];
const confirmed = process.argv.includes('--yes');

async function main() {
  const res = await pool.query(
    `SELECT sd.id, sd.name, sd.dept_name, sd.status, s.key AS space_key
     FROM sla_definitions sd
     LEFT JOIN spaces s ON s.id = sd."spaceId"
     WHERE LOWER(sd.name) = ANY($1::text[])
     ORDER BY s.key, sd.name`,
    [TARGET_NAMES]
  );

  if (res.rows.length === 0) {
    console.log('No SLA policies named "tsa" or "testing" found. Nothing to do.');
    await pool.end();
    return;
  }

  console.log(`Found ${res.rows.length} matching SLA polic${res.rows.length === 1 ? 'y' : 'ies'}:`);
  for (const r of res.rows) {
    console.log(`  [${r.space_key || '?'}] "${r.name}" (id=${r.id}, dept=${r.dept_name || '<all depts>'}, status=${r.status})`);
  }

  if (!confirmed) {
    console.log('\nDry run only -- rerun with --yes to delete the policies listed above.');
    await pool.end();
    return;
  }

  const ids = res.rows.map(r => r.id);
  await pool.query(`DELETE FROM sla_definitions WHERE id = ANY($1::text[])`, [ids]);
  console.log(`\nDeleted ${ids.length} SLA polic${ids.length === 1 ? 'y' : 'ies'}.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
