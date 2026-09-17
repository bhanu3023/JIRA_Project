// The names flagged by check-sla-breach-accuracy.mjs (Pallavi K, dathu,
// Devarapu Kota siva, Tanmai Arangi) all turned out to have REAL user
// accounts with real emails already on the roster (per
// check-migration-duplicate-accounts.mjs) -- yet the API response showed
// their assignee.email as null for these tickets, which is why the
// roster-membership check (keyed on email) flagged them as "not on
// roster". That check may itself be a false positive: if these tickets'
// assignee comes from a dept_assignees SNAPSHOT whose id correctly points
// at the real roster user but whose own stored `email` field is null
// (an older snapshot format/capture that predates email being included),
// the person IS really on the roster -- only the snapshot's email field is
// stale, not the assignment itself.
//
// Pulls the raw row for each flagged ticket to see which it actually is.
//
// Read-only.
//
// Usage: node check-migration-assignee-snapshot-ids.mjs CF-KEY_OR_INTERNAL_KEY ...

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['L1BOAR-5648', 'L1BOAR-5703', 'L1BOAR-5750', 'L1BOAR-6602', 'L1BOAR-30190'];

async function main() {
  for (const key of KEYS) {
    const { rows } = await pool.query(
      `SELECT key, cf_key, current_department, "assigneeId", dept_assignees, jira_assignee_name
       FROM issues WHERE key = $1 OR cf_key = $1`,
      [key]
    );
    if (!rows.length) { console.log(`${key}: NOT FOUND`); continue; }
    const r = rows[0];
    console.log(`\n${r.key} (${r.cf_key}):`);
    console.log(`  current_department=${r.current_department}`);
    console.log(`  assigneeId (live)=${r.assigneeId}`);
    console.log(`  jira_assignee_name (raw imported text)=${r.jira_assignee_name}`);
    console.log(`  dept_assignees snapshot=${JSON.stringify(r.dept_assignees)}`);

    if (r.assigneeId) {
      const { rows: u } = await pool.query(`SELECT id, email, "firstName", "lastName" FROM users WHERE id = $1`, [r.assigneeId]);
      console.log(`  -> live assigneeId resolves to: ${u[0] ? `${u[0].firstName} ${u[0].lastName} <${u[0].email}>` : '(not found)'}`);
    }
    const deptAssignees = r.dept_assignees || {};
    const migKey = Object.keys(deptAssignees).find((k) => k.toLowerCase() === 'migration');
    const snap = migKey ? deptAssignees[migKey] : null;
    if (snap?.id) {
      const { rows: u } = await pool.query(`SELECT id, email, "firstName", "lastName" FROM users WHERE id = $1`, [snap.id]);
      console.log(`  -> Migration snapshot id resolves to REAL user: ${u[0] ? `${u[0].firstName} ${u[0].lastName} <${u[0].email}>` : '(not found)'}`);
      console.log(`     (snapshot itself stored email=${snap.email})`);
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
