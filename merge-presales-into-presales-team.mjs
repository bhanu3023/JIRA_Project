// One-time data change, per explicit request: merge the "Pre-Sales" queue
// into "Pre-Sales-Team" on CloudFuze Board (TESTIN), then delete the
// "Pre-Sales" queue entirely. Confirmed via check-presales-queues.mjs /
// check-presales-merge-details.mjs:
//   - 146 issues currently sit in current_department='Pre-Sales'; all 146
//     also have original_dept='Pre-Sales' (so both move together).
//   - None of their dept_statuses/dept_assignees/dept_sla_log/
//     dept_sla_started_at JSONB maps reference "Pre-Sales" at all -- no key
//     renaming needed there.
//   - presalesteam@cloudfuze.com's email_configs row already routes to
//     "Pre-Sales-Team" (not touched by this script, already correct).
//   - queue_closed_tickets (61 rows) / issue_dept_transitions (125 rows)
//     referencing "Pre-Sales" are left untouched -- those are historical
//     records of what actually happened, not live state.
//   - "Pre-Sales-Old" (a separate, third queue, 1380 issues) is NOT part of
//     this request and is left completely alone.
//
// Dry-run by default -- pass --apply to write.
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';
const FROM_DEPT = 'Pre-Sales';
const TO_DEPT = 'Pre-Sales-Team';
const DELETE_QUEUE_ID = 'cq_1793011005537'; // the empty "Pre-Sales" queue entry itself

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [SPACE_KEY]);
  const spaceId = spaceRows[0]?.id;
  if (!spaceId) throw new Error(`Space ${SPACE_KEY} not found`);

  const { rows: affected } = await pool.query(
    `SELECT key FROM issues WHERE "spaceId" = $1 AND current_department = $2`,
    [spaceId, FROM_DEPT],
  );
  console.log(`Issues to move: ${affected.length} (${FROM_DEPT} -> ${TO_DEPT})`);
  console.log(`First few keys: ${affected.slice(0, 5).map((r) => r.key).join(', ')}${affected.length > 5 ? ', ...' : ''}`);

  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  let queues = cqRows[0]?.queues || [];
  if (typeof queues === 'string') { try { queues = JSON.parse(queues); } catch {} }
  const toDelete = queues.find((q) => q.id === DELETE_QUEUE_ID);
  if (!toDelete) {
    console.log(`\nQueue id ${DELETE_QUEUE_ID} not found in custom_queues -- aborting, nothing changed.`);
    await pool.end();
    return;
  }
  console.log(`\nQueue to delete: "${toDelete.name}" (id=${toDelete.id}, members=${JSON.stringify(toDelete.memberIds)})`);
  const remainingQueues = queues.filter((q) => q.id !== DELETE_QUEUE_ID);
  console.log(`Remaining queues after delete: ${remainingQueues.map((q) => q.name).join(', ')}`);

  if (!APPLY) {
    console.log(`\nDry run only -- would move ${affected.length} issue(s) and delete the "${toDelete.name}" queue. Rerun with --apply to write.`);
    await pool.end();
    return;
  }

  const { rowCount } = await pool.query(
    `UPDATE issues SET current_department = $1, original_dept = $1, "updatedAt" = NOW()
     WHERE "spaceId" = $2 AND current_department = $3`,
    [TO_DEPT, spaceId, FROM_DEPT],
  );
  console.log(`\nMoved ${rowCount} issue(s) to ${TO_DEPT}.`);

  await pool.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [JSON.stringify(remainingQueues), SPACE_KEY]);
  console.log(`Deleted the "${toDelete.name}" queue from ${SPACE_KEY}'s custom_queues.`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
