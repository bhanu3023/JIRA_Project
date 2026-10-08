// Neither hypothesis checked so far (Dev queue membership) explained the 20
// Filters-but-not-MBR tickets. Next theory: these tickets passed through Dev
// at some point (even if currently tagged Migration), leaving a
// user_worked_on_tickets row with dept='Dev' -- Filters' Queue filter has an
// existing "broadenIt" feature that, when a date range is active, includes
// any ticket a department touched during that window regardless of its
// CURRENT department. MBR's deptMatchSql has an equivalent worked-on check
// but restricts it to roster members only, which could explain the gap if
// these Dev visits were logged under a non-Dev-roster person. Checks the
// raw user_worked_on_tickets rows for these exact tickets directly. Read-only.
//
// Usage: node check-worked-on-dev-history.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = [
  'CF-29904', 'CF-29902', 'CF-29827', 'CF-33117', 'CF-33000', 'CF-30696', 'CF-30778', 'CF-29406',
  'CF-30821', 'CF-29640', 'CF-29690', 'CF-29348', 'CF-29842', 'CF-29926', 'CF-29346', 'CF-29320',
  'CF-29397', 'CF-29826', 'CF-30360', 'CF-29407',
];

async function main() {
  const { rows: issueRows } = await pool.query(`SELECT id, COALESCE(cf_key, key) AS key FROM issues WHERE COALESCE(cf_key, key) = ANY($1::text[])`, [KEYS]);
  const idToKey = Object.fromEntries(issueRows.map((r) => [r.id, r.key]));
  const ids = issueRows.map((r) => r.id);

  const { rows } = await pool.query(`
    SELECT w.issue_id, w.dept, w.reason, wu.email AS worker_email, w.worked_at
    FROM user_worked_on_tickets w
    LEFT JOIN users wu ON wu.id = w.user_id
    WHERE w.issue_id = ANY($1::text[])
    ORDER BY w.issue_id, w.worked_at ASC
  `, [ids]);

  console.log(`=== user_worked_on_tickets rows for the 20 gap tickets ===\n`);
  let lastId = null;
  for (const r of rows) {
    if (r.issue_id !== lastId) { console.log(`\n${idToKey[r.issue_id]}:`); lastId = r.issue_id; }
    console.log(`  dept=${r.dept} reason=${r.reason} worker=${r.worker_email || 'null'} at=${r.worked_at?.toISOString?.()}`);
  }

  const DEV_ROSTER = [
    'abhinandan.kumar@cloudfuze.com', 'akhila.aenkoju@cloudfuze.com', 'akib.mohd@cloudfuze.com', 'ankit@cloudfuze.com',
    'bhagyashri.deokar@cloudfuze.com', 'hemadasu.kantam@cloudfuze.com', 'jaswanth.adari@cloudfuze.com', 'lakshmi.adabala@cloudfuze.com',
    'mayank@cloudfuze.com', 'naved.osama@cloudfuze.com', 'pragati.pandey@cloudfuze.com', 'ravi.srivastava@cloudfuze.com',
    'rehan.khan@cloudfuze.com', 'sairaj.kanigicharla@cloudfuze.com', 'shiva.amuda@cloudfuze.com', 'shivam.singh@cloudfuze.com',
    'srinu.gudimitla@cloudfuze.com', 'vamsi.malla@cloudfuze.com', 'vishal.kumar@cloudfuze.com',
  ];
  const devRows = rows.filter((r) => (r.dept || '').toLowerCase() === 'dev');
  console.log(`\n=== Dev-dept worked-on rows specifically (${devRows.length}) ===`);
  for (const r of devRows) {
    const inRoster = DEV_ROSTER.includes((r.worker_email || '').toLowerCase());
    console.log(`  ${idToKey[r.issue_id]}: worker=${r.worker_email || 'null'} reason=${r.reason} inDevRoster=${inRoster}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
