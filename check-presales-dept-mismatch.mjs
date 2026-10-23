// Read-only: CF-34438's current_department is literally "Pre-sales", but no
// queue in this space is named exactly that (only "Pre-Sales-Old" and
// "Pre-Sales-Team" exist) -- isUserAuthorizedForDeptQueue fails OPEN when it
// can't find a matching queue, so nobody is "really" authorized here and the
// ticket is effectively homeless. Likely cause: some OTHER queue still has a
// status literally named "Routed to Pre-sales" / "Waiting for Pre-sales"
// (stale text baked in before a rename), and handoff logic extracts the
// target department from that status NAME string, not from the live queue
// list. This finds every such stale status reference across all queues, and
// shows how many tickets are currently stuck with a current_department that
// doesn't match any real queue.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [SPACE_KEY]);
  const spaceId = spaceRows[0]?.id;

  const { rows: qRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = qRows[0]?.queues || [];

  console.log('--- All queues in space ---');
  for (const q of queues) {
    console.log(`"${q.name}" (id=${q.id}, members=${(q.memberIds || []).length})`);
  }

  console.log('\n--- Statuses across ALL queues mentioning "pre-sales" (case-insensitive) ---');
  for (const q of queues) {
    for (const s of (q.queueStatuses || [])) {
      if (/pre.?sales/i.test(s.name || '')) {
        console.log(`Queue "${q.name}" has status "${s.name}" (id=${s.id})`);
      }
    }
  }

  console.log('\n--- Distinct current_department values that do NOT match any real queue name ---');
  const { rows: deptRows } = await pool.query(
    `SELECT current_department, COUNT(*) AS cnt FROM issues WHERE "spaceId" = $1 AND current_department IS NOT NULL GROUP BY current_department ORDER BY cnt DESC`,
    [spaceId]
  );
  const queueNamesLower = new Set(queues.map((q) => (q.name || '').toLowerCase()));
  for (const d of deptRows) {
    const matches = queueNamesLower.has((d.current_department || '').toLowerCase());
    if (!matches) console.log(`"${d.current_department}": ${d.cnt} ticket(s) -- NO MATCHING QUEUE`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
