/**
 * fix-dev-queue-transitions.mjs
 *
 * Fixes a regression introduced by add-presales-queue-status.mjs.
 *
 * The "Move to status" dropdown (src/app/issues/[issueKey]/page.tsx) has a
 * fallback rule: if the current status has ZERO explicit queueTransitions
 * entries pointing away from it, show every other status (unconstrained);
 * if it has even one, show ONLY those explicit targets.
 *
 * Before add-presales-queue-status.mjs ran, Open/In Progress/Waiting for
 * Migration/Waiting for QA/Waiting for Infra in the Dev queue all had ZERO
 * matching transitions (the queue's queueTransitions array only had stale
 * entries referencing status ids that no longer exist), so the dropdown
 * fell back to "show all" for each of them. That script added exactly ONE
 * new transition from each of those five statuses (-> Waiting for
 * Pre-Sales) -- flipping every one of them from "zero matches, show all"
 * to "one match, show only that one," which is why the dropdown collapsed
 * down to a single "Waiting for Pre-Sales" option instead of the full list.
 *
 * This restores full connectivity: for each of those five statuses, adds
 * an explicit transition to every other status in the Dev queue (Open, In
 * Progress, Waiting for Migration/QA/Infra/Pre-Sales, Resolved) that isn't
 * already there, so the dropdown shows the complete list again instead of
 * relying on the fragile "zero transitions" fallback.
 *
 * SAFE BY DEFAULT: dry run unless DRY_RUN=false is passed explicitly.
 *
 * Run: node fix-dev-queue-transitions.mjs
 * Apply for real: DRY_RUN=false node fix-dev-queue-transitions.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const DRY_RUN = process.env.DRY_RUN !== 'false';

// Every status a Dev-queue ticket should be able to move to.
const GROUP_IDS = [
  'qst_dev_open',
  'qst_dev_inprogress',
  'qst_dev_waitingmigration',
  'qst_dev_waitingqa',
  'qst_dev_waitinginfra',
  'qst_dev_resolved',
  'qst_waiting_presales',
];

// The five statuses add-presales-queue-status.mjs accidentally made
// "restricted" by giving them exactly one outgoing transition.
const FROM_STATUSES_TO_FIX = [
  'qst_dev_open',
  'qst_dev_inprogress',
  'qst_dev_waitingmigration',
  'qst_dev_waitingqa',
  'qst_dev_waitinginfra',
];

async function main() {
  const rows = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  const plan = [];

  for (const row of rows.rows) {
    const queues = row.queues || [];
    const devQueue = queues.find((q) => (q.name || '').toLowerCase() === 'dev');
    if (!devQueue) continue;

    devQueue.queueTransitions = devQueue.queueTransitions || [];
    const added = [];

    for (const fromId of FROM_STATUSES_TO_FIX) {
      for (const toId of GROUP_IDS) {
        if (toId === fromId) continue;
        const exists = devQueue.queueTransitions.some(
          (t) => (t.fromStatusId ?? t.from) === fromId && (t.toStatusId ?? t.to) === toId
        );
        if (!exists) {
          devQueue.queueTransitions.push({ fromStatusId: fromId, toStatusId: toId, name: '' });
          added.push(`${fromId} -> ${toId}`);
        }
      }
    }

    if (added.length > 0) {
      plan.push({ space: row.space_key, queue: devQueue.name, addedTransitions: added });
      if (!DRY_RUN) {
        await pool.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [JSON.stringify(queues), row.space_key]);
      }
    }
  }

  console.log(`${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'} ${plan.length} Dev queue row(s):`);
  console.log(JSON.stringify(plan, null, 2));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
