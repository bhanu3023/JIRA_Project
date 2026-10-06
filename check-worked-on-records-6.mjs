// All 6 missing tickets have Pragati credited via user_worked_on_tickets
// (not current assigneeId, not dept_assignees.Dev) -- that broadening
// should ALSO apply to the bare "Queue: Dev" listing (no assignee
// filter), not just the Assignee:Pragati-filtered one, since both use
// the same EXISTS(user_worked_on_tickets...) clause gated only on
// queueMembersOnly + a date/status filter being active, not on whether
// an assignee is specified. Checking the actual worked_on rows (dept
// value, reason, user_id) to find where the two code paths actually
// diverge. Also checking Rehan Khan/other final assignees' own Dev
// queue membership, since CF-33197 is STILL in Dev with a plain
// current assigneeId that alone should qualify it. Read-only.
//
// Usage: node check-worked-on-records-6.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = ['CF-33608', 'CF-33489', 'CF-33371', 'CF-33283', 'CF-33197', 'CF-30691'];
const PRAGATI_ID = 'pg_on73cwx5te';

async function main() {
  const { rows: issues } = await pool.query(`SELECT id, COALESCE(cf_key,key) AS key FROM issues WHERE cf_key = ANY($1::text[]) OR key = ANY($1::text[])`, [KEYS]);
  const idByKey = new Map(issues.map(i => [i.key, i.id]));

  for (const key of KEYS) {
    const id = idByKey.get(key);
    const { rows: worked } = await pool.query(`
      SELECT dept, reason, user_id, "createdAt"
      FROM user_worked_on_tickets WHERE issue_id = $1 ORDER BY "createdAt" ASC
    `, [id]);
    console.log(`\n${key} worked-on records:`);
    for (const w of worked) {
      console.log(`  dept="${w.dept}" reason=${w.reason} user_id=${w.user_id}${w.user_id === PRAGATI_ID ? '  <-- PRAGATI' : ''} at=${w.createdAt?.toISOString?.()}`);
    }
  }

  // Dev queue's configured memberIds -- is Pragati actually in it?
  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const devQueue = (cq[0]?.queues || []).find(q => q.name === 'Dev');
  console.log(`\nDev queue memberIds includes Pragati (${PRAGATI_ID})? ${devQueue?.memberIds?.includes(PRAGATI_ID)}`);
  console.log(`Dev queue total memberIds: ${devQueue?.memberIds?.length}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
