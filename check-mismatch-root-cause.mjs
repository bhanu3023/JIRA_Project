// Read-only: for the 13 tickets Filters counts under Queue: Dev but MBR's
// Customer Engineering tab doesn't, dump their user_worked_on_tickets rows
// and the live Dev queue roster, to find exactly which predicate diverges.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const MISMATCHED = [
  'CF-26109','CF-30766','CF-29905','CF-33432','CF-33392','CF-32853','CF-30865',
  'CF-29552','CF-31345','CF-30770','CF-30742','CF-33222','CF-33052',
];

async function main() {
  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const devQueue = (cq[0]?.queues || []).find((q) => String(q.name || '').toLowerCase() === 'dev');
  const memberIds = devQueue?.memberIds || [];
  const { rows: memberRows } = await pool.query(`SELECT email FROM users WHERE id = ANY($1::text[])`, [memberIds]);
  const rosterEmails = new Set(memberRows.map((r) => r.email.toLowerCase()));
  console.log(`Live Dev queue roster: ${rosterEmails.size} member(s)\n`);

  for (const cfKey of MISMATCHED) {
    const { rows } = await pool.query(
      `SELECT id FROM issues WHERE cf_key = $1 OR key = $1`, [cfKey]
    );
    const issueId = rows[0]?.id;
    if (!issueId) { console.log(`${cfKey}: issue not found`); continue; }
    const { rows: worked } = await pool.query(
      `SELECT w.dept, w.reason, wu.email
       FROM user_worked_on_tickets w LEFT JOIN users wu ON wu.id = w.user_id
       WHERE w.issue_id = $1 ORDER BY w.dept`,
      [issueId]
    );
    console.log(`${cfKey}:`);
    if (!worked.length) {
      console.log(`  NO user_worked_on_tickets rows at all`);
    }
    for (const w of worked) {
      const isDev = (w.dept || '').toLowerCase() === 'dev';
      const onRoster = w.email && rosterEmails.has(w.email.toLowerCase());
      console.log(`  dept="${w.dept}" reason="${w.reason}" user=${w.email || 'NULL'} | isDevDept=${isDev} onDevRoster=${onRoster}`);
    }
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
