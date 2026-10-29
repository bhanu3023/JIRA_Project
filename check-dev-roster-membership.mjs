// Read-only: is the person who actually did the Dev work on these 4
// mismatched tickets still a member of the LIVE Dev queue? MBR's team-scope
// matching (deptMatchSql/rosterMatchSql) only credits a worked-on-Dev record
// toward the Dev team if that worker is a CURRENT Dev queue member --
// Filters' own plain "Queue: Dev" match may not have that same restriction.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const devQueue = (cq[0]?.queues || []).find((q) => String(q.name || '').toLowerCase() === 'dev');
  const memberIds = devQueue?.memberIds || [];
  const { rows: memberRows } = await pool.query(`SELECT email FROM users WHERE id = ANY($1::text[])`, [memberIds]);
  const rosterEmails = new Set(memberRows.map((r) => r.email.toLowerCase()));
  console.log(`Live Dev queue roster: ${rosterEmails.size} members\n`);

  const checkPeople = {
    'CF-33837': ['vignesh.t@cloudfuze.com', 'kamal.basha@cloudfuze.com', 'shiva.amuda@cloudfuze.com'],
    'CF-33699': ['praveen.kothagolla@cloudfuze.com', 'vimalesh.t@cloudfuze.com'],
    'CF-34598': ['rehan.khan@cloudfuze.com', 'ravi.srivastava@cloudfuze.com'],
    'CF-34629': ['ravi.srivastava@cloudfuze.com'],
  };
  for (const [key, people] of Object.entries(checkPeople)) {
    console.log(`${key}:`);
    for (const p of people) console.log(`  ${p}: onDevRoster=${rosterEmails.has(p.toLowerCase())}`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
