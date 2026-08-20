/**
 * check-presales-people.mjs
 * READ-ONLY. Looks for any existing signal in this app's own data about who
 * the Pre-Sales team actually is, before guessing who to add as members of
 * the new "Pre-Sales" custom queue (created with memberIds: [] since no one
 * was specified at the time):
 *
 *   1. rr_config -- does any space already have a "Pre-Sales" round-robin
 *      department configured with real agents? (the Department custom
 *      field's per-option employee list is legacy/unused; rr_config is
 *      where real round-robin agents for a department actually live)
 *   2. space_members -- any user row with a department/role value that
 *      mentions "pre-sales"/"presales"
 *   3. For comparison, how the other existing queues (Migration, Dev, QA,
 *      Infra) are staffed today (memberIds count per queue)
 *
 * Run: DATABASE_URL=... node check-presales-people.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

async function main() {
  console.log('========== rr_config departments mentioning Pre-Sales ==========');
  const rr = await pool.query(`SELECT space_id, departments FROM rr_config`);
  let foundRr = false;
  for (const row of rr.rows) {
    const depts = row.departments || [];
    for (const d of depts) {
      if ((d.name || '').toLowerCase().includes('pre-sales') || (d.name || '').toLowerCase().includes('presales')) {
        foundRr = true;
        console.log(`space_id=${row.space_id}`, JSON.stringify(d, null, 2));
      }
    }
  }
  if (!foundRr) console.log('No existing rr_config department mentions Pre-Sales.');

  console.log('\n========== space_members with a department/role mentioning presales ==========');
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='space_members'`);
  console.log('space_members columns:', cols.rows.map((r) => r.column_name).join(', '));
  const sm = await pool.query(`
    SELECT * FROM space_members WHERE department ILIKE '%pre%sales%' OR department ILIKE '%presales%'
  `).catch(() => ({ rows: [] }));
  console.log(JSON.stringify(sm.rows, null, 2));

  console.log('\n========== Existing queue staffing, for comparison ==========');
  const queues = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  for (const row of queues.rows) {
    for (const q of row.queues || []) {
      console.log(`${row.space_key} / ${q.name}: ${(q.memberIds || []).length} member(s)`);
    }
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
